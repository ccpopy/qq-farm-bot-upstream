const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const protobuf = require('protobufjs');

const root = new protobuf.Root().loadSync(
    path.join(__dirname, '../src/proto/activitypb.proto'),
    { keepCase: true },
);
root.add(protobuf.Root.fromJSON(
    new protobuf.Root().loadSync(path.join(__dirname, '../src/proto/maple-market.proto'), { keepCase: true }).toJSON(),
));

const types = Object.fromEntries([
    'GetGroupRequest',
    'GetGroupReply',
    'MapleMarketOperateRequest',
    'ActivityOperateReply',
].map(name => [name, root.lookupType(`gamepb.activitypb.${name}`)]));

const encode = (type, data) => Buffer.from(type.encode(type.fromObject(data)).finish());

function loadWithMocks(targetPath, mocks) {
    const snapshots = new Map();
    for (const [rel, exports] of Object.entries(mocks)) {
        const id = require.resolve(path.resolve(__dirname, '../dist', rel));
        snapshots.set(id, require.cache[id]);
        require.cache[id] = { id, filename: id, loaded: true, exports };
    }
    const targetId = require.resolve(path.resolve(__dirname, '../dist', targetPath));
    const prevTarget = require.cache[targetId];
    delete require.cache[targetId];
    const mod = require(targetId);
    const restore = () => {
        if (prevTarget) require.cache[targetId] = prevTarget;
        else delete require.cache[targetId];
        for (const [id, prev] of snapshots.entries()) {
            if (prev) require.cache[id] = prev;
            else delete require.cache[id];
        }
    };
    return { mod, restore };
}

function createHarness(t, options = {}) {
    let now = options.now ?? 1795680000;
    let shareReportFails = !!options.shareReportFails;
    let invalidateCount = 0;
    const calls = [];
    const marketState = {
        daily_state: { seed_claimed: false, shared: false },
        activity_coin: 300,
        red_dots: { seed_unclaimed: true, share_unclaimed: true, purchase_log_unread: true },
        price_rate_bp: 0,
        pending_commission_coin: 24,
        pending_commission_count: 2,
    };
    const shopState = {
        base_price: 240,
        boost_value: 0,
        remain_quota: 7500,
        owner: { gid: 10001, name: '测试农场' },
    };
    const bag = options.bag || [
        { id: 20307, count: 5 },
        { id: 1032, count: 12 },
        { id: 1032, count: 4, locked: true },
    ];
    const goodsList = [
        { goods_id: 2, activity_coin_price: 100, limit_type: 1, limit_times: 3, purchased_daily: 1, purchased_total: 1, exchangeable: true },
        { goods_id: 1, activity_coin_price: 500, limit_type: 2, limit_times: 1, purchased_daily: 0, purchased_total: 0, exchangeable: true },
    ];
    const fields = {
        91: 'maple_market_claim_seed',
        92: 'maple_market_get_shop',
        93: 'maple_market_sell',
        95: 'maple_market_get_purchase_log',
        96: 'maple_market_exchange',
        97: 'maple_market_get_goods_list',
        98: 'maple_market_share_boost',
        99: 'maple_market_claim_commission',
    };

    const { mod: service, restore } = loadWithMocks('services/maple-market', {
        'utils/proto': { types },
        'utils/utils': { toNum: v => Number(v) || 0, getServerTimeSec: () => now },
        'config/gameConfig': {
            getItemById: id => ({ name: `物品#${id}`, desc: `说明#${id}` }),
            getItemImageById: id => `/game-config/seed_images_named/seed_images/${id}.png`,
        },
        'services/warehouse': {
            getBag: async () => ({ items: bag }),
            getBagItems: reply => reply.items,
            isItemLocked: item => !!item.locked,
        },
        'services/activity-windows': {
            invalidateActivityWindows: () => { invalidateCount++; },
        },
        'services/share': {
            checkCanShare: async () => {
                if (shareReportFails) throw new Error('share status unavailable');
                return { can_share: true };
            },
            reportActivityShare: async (source, scene) => {
                calls.push({ method: 'ReportShare', source, scene });
                if (shareReportFails) throw new Error('share report unavailable');
            },
        },
        'utils/network': {
            getUserState: () => ({ gid: 10001 }),
            sendMsgAsync: async (_service, method, body) => {
                if (method === 'GetGroup') {
                    return {
                        body: encode(types.GetGroupReply, {
                            group: {
                                activity: { activity_id: '2026111707' },
                                children: [{
                                    activity: {
                                        activity_id: '2026111708',
                                        begin_time: 1795600000,
                                        end_time: 1796200000,
                                        settle_start_time: 1796000000,
                                        field_20: 1,
                                        extra: Buffer.from(JSON.stringify({ tips: { txt: ['<b>活动说明</b>', '第一条规则'] } }), 'utf8'),
                                    },
                                    maple_market: marketState,
                                }],
                            },
                        }),
                    };
                }
                const req = types.MapleMarketOperateRequest.toObject(
                    types.MapleMarketOperateRequest.decode(body),
                    { longs: String },
                );
                const cmd = Number(req.cmd);
                let result;
                if (cmd === 92) {
                    result = { shop: shopState, can_sell: true };
                } else if (cmd === 97) {
                    result = { goods: goodsList, activity_coin: marketState.activity_coin };
                } else if (cmd === 95) {
                    result = {
                        records: [
                            { timestamp: 1795679000, seller_gid: 20002, sold_count: 10, income: 3000, seller_name: '好友A', seller_level: 12, commission: 60 },
                            { timestamp: 1795679500, seller_gid: 20003, sold_count: 5, income: 1500, seller_name: '', seller_level: 8, commission: 30 },
                        ],
                    };
                } else {
                    calls.push(req);
                    if (cmd === 91) {
                        marketState.daily_state.seed_claimed = true;
                        marketState.red_dots.seed_unclaimed = false;
                        bag[0].count += 3;
                        result = { seed: { id: 20307, count: 3 } };
                    } else if (cmd === 98) {
                        marketState.daily_state.shared = true;
                        marketState.red_dots.share_unclaimed = false;
                        marketState.price_rate_bp = 2500;
                        marketState.boost_value = 60;
                        shopState.boost_value = 60;
                        bag[0].count += 1;
                        result = { seed: { id: 20307, count: 1 }, boost_value: 60, final_price: 300, price_rate_bp: 2500, boosted: true };
                    } else if (cmd === 99) {
                        const claimed = marketState.pending_commission_coin;
                        const count = marketState.pending_commission_count;
                        marketState.activity_coin += claimed;
                        marketState.pending_commission_coin = 0;
                        marketState.pending_commission_count = 0;
                        result = { claimed_coin: claimed, claimed_count: count, activity_coin: marketState.activity_coin };
                    } else if (cmd === 93) {
                        const count = Number(req.maple_market_sell.sell_count);
                        const unitPrice = shopState.base_price + shopState.boost_value;
                        const income = count * unitPrice;
                        bag[1].count -= count;
                        marketState.activity_coin += income;
                        result = { sold_count: count, final_price: unitPrice, activity_coin_income: income, remain_quota: shopState.remain_quota, activity_coin: marketState.activity_coin };
                    } else if (cmd === 96) {
                        const goodsId = Number(req.maple_market_exchange.goods_id);
                        const count = Number(req.maple_market_exchange.exchange_count);
                        const row = goodsList.find(item => item.goods_id === goodsId);
                        const cost = row.activity_coin_price * count;
                        marketState.activity_coin -= cost;
                        row.purchased_daily += count;
                        row.purchased_total += count;
                        result = {
                            activity_coin_cost: cost,
                            items: [{ id: 101627, count }],
                            activity_coin: marketState.activity_coin,
                            purchased_daily: row.purchased_daily,
                            purchased_total: row.purchased_total,
                        };
                    }
                }
                return {
                    body: encode(types.ActivityOperateReply, {
                        activity_id: req.id,
                        operate_type: cmd,
                        data: { activity: { activity_id: '2026111708' }, maple_market: marketState },
                        [fields[cmd]]: result,
                    }),
                };
            },
        },
    });
    t.after(restore);
    return {
        service,
        calls,
        marketState,
        shopState,
        bag,
        getInvalidateCount: () => invalidateCount,
        setTime: v => { now = v; },
        setShareReportFails: v => { shareReportFails = v; },
    };
}

test('MapleMarketOperateRequest and ActivityOperateReply round-trip all maple-market fields', () => {
    const reqPayload = { id: '2026111708', cmd: 93, maple_market_sell: { target_gid: 10001, sell_count: 5 } };
    const decodedReq = types.MapleMarketOperateRequest.toObject(
        types.MapleMarketOperateRequest.decode(encode(types.MapleMarketOperateRequest, reqPayload)),
        { longs: String },
    );
    assert.deepEqual(decodedReq, { id: '2026111708', cmd: '93', maple_market_sell: { target_gid: '10001', sell_count: '5' } });

    const replyPayload = {
        activity_id: '2026111708',
        operate_type: 98,
        data: { activity: { activity_id: '2026111708' }, maple_market: { activity_coin: 120, price_rate_bp: 1500 } },
        maple_market_share_boost: { boost_value: 30, final_price: 230, price_rate_bp: 1500, boosted: true },
    };
    const decodedReply = types.ActivityOperateReply.toObject(
        types.ActivityOperateReply.decode(encode(types.ActivityOperateReply, replyPayload)),
        { longs: String },
    );
    assert.equal(decodedReply.data.maple_market.price_rate_bp, '1500');
    assert.equal(decodedReply.maple_market_share_boost.final_price, '230');
});

test('getMapleMarketActivity aggregates state, own quote, catalog, and unlocked crop stock', async (t) => {
    const h = createHarness(t);
    const state = await h.service.getMapleMarketActivity();
    assert.equal(state.phase, 'active');
    assert.equal(state.coinBalance, 300);
    assert.equal(state.seedStock, 5);
    assert.equal(state.cropStock, 16);
    assert.equal(state.sellableCropStock, 12);
    assert.equal(state.quote.unitPrice, 240);
    assert.equal(state.quote.tier, '高价');
    assert.equal(state.quote.complete, false);
    assert.deepEqual(state.rules, ['活动说明', '第一条规则']);
    assert.equal(state.goods[0].remaining, 2);
});

test('claimSeed, shareBoost, and claimCommission confirm results and share report errors do not fail shareBoost', async (t) => {
    const h = createHarness(t, { shareReportFails: true });
    const seedRes = await h.service.claimMapleMarketSeed();
    assert.equal(seedRes.status, 'confirmed');
    assert.equal(seedRes.data.seed.count, 3);
    const seedSkipped = await h.service.claimMapleMarketSeed();
    assert.equal(seedSkipped.status, 'skipped');

    const shareRes = await h.service.shareMapleMarketBoost();
    assert.equal(shareRes.status, 'confirmed');
    assert.equal(shareRes.data.boost, 60);
    assert.equal(shareRes.data.finalPrice, 300);
    assert.equal(shareRes.data.priceRateBp, 2500);

    const refreshed = await h.service.getMapleMarketActivity();
    assert.equal(refreshed.quote.priceRateBp, 2500);
    assert.equal(refreshed.quote.complete, true);

    const commRes = await h.service.claimMapleMarketCommission();
    assert.equal(commRes.status, 'confirmed');
    assert.equal(commRes.data.claimedCoin, 24);
    assert.equal(commRes.data.coinBalance, 324);
    assert.equal(h.getInvalidateCount(), 3);
});

test('sellMapleMarketCrop enforces price guard, locked stock exclusion, and updates coin balance', async (t) => {
    const h = createHarness(t);
    await assert.rejects(h.service.sellMapleMarketCrop(0, 240), /有效的出售数量/);
    await assert.rejects(h.service.sellMapleMarketCrop(5, 250), /收购价已变化/);
    await assert.rejects(h.service.sellMapleMarketCrop(13, 240), /可用蜜薯不足/);
    const sold = await h.service.sellMapleMarketCrop(10, 240);
    assert.deepEqual(sold, { sold: 10, unitPrice: 240, income: 2400, coinBalance: 2700 });
});

test('exchangeMapleMarketGoods enforces limit, coin balance, and price guard, and purchaseLog sorts descending', async (t) => {
    const h = createHarness(t);
    await assert.rejects(h.service.exchangeMapleMarketGoods(2, 1, 99), /商品价格已变化/);
    await assert.rejects(h.service.exchangeMapleMarketGoods(2, 3, 100), /超过剩余限购/);
    await assert.rejects(h.service.exchangeMapleMarketGoods(1, 1, 500), /福气币不足/);
    const exchanged = await h.service.exchangeMapleMarketGoods(2, 2, 100);
    assert.equal(exchanged.cost, 200);
    assert.equal(exchanged.coinBalance, 100);
    assert.equal(exchanged.remaining, 0);

    const logRes = await h.service.getMapleMarketPurchaseLog();
    assert.equal(logRes.records.length, 2);
    assert.equal(logRes.records[0].sellerName, 'GID:20003');
    assert.equal(logRes.records[1].sellerName, '好友A');
});

test('commerce-routes mounts the maple-market activity routes', async (t) => {
    const { mod: routes, restore } = loadWithMocks('controllers/admin/commerce-routes', {
        'controllers/admin/middleware': { getAccId: (_ctx, req) => req.headers?.['x-account-id'] || '' },
        'models/store': { getRanchFriendBlacklist: () => [], setRanchFriendBlacklist: () => [] },
    });
    t.after(restore);

    const registered = [];
    const app = {
        get: (routePath, handler) => registered.push({ method: 'GET', path: routePath, handler }),
        post: (routePath, handler) => registered.push({ method: 'POST', path: routePath, handler }),
    };
    const providerCalls = [];
    const ctx = {
        provider: new Proxy({}, {
            get: (_target, prop) => async (...args) => {
                providerCalls.push([prop, ...args]);
                return { called: prop };
            },
        }),
    };

    routes.mountCommerceRoutes(app, ctx);
    const mapleRoutes = registered.filter(r => r.path.startsWith('/api/activities/maple-market'));
    assert.deepEqual(
        mapleRoutes.map(r => `${r.method} ${r.path}`),
        [
            'GET /api/activities/maple-market',
            'GET /api/activities/maple-market/purchase-log',
            'POST /api/activities/maple-market/claim-seed',
            'POST /api/activities/maple-market/share-boost',
            'POST /api/activities/maple-market/claim-commission',
            'POST /api/activities/maple-market/sell',
            'POST /api/activities/maple-market/exchange',
        ],
    );

    const sellRoute = mapleRoutes.find(r => r.path === '/api/activities/maple-market/sell');
    let payload;
    await sellRoute.handler(
        { headers: { 'x-account-id': 'acc-1' }, body: { count: 4, expectedUnitPrice: 240 } },
        { status: () => ({ json: v => { payload = v; } }), json: v => { payload = v; } },
    );
    assert.deepEqual(payload, { ok: true, data: { called: 'sellMapleMarketCrop' } });
    assert.deepEqual(providerCalls[0], ['sellMapleMarketCrop', 'acc-1', 4, 240]);
});

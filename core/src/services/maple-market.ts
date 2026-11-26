import config from '../activity-data/maple-market-20261125.json';

export {};

const { getUserState, sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { getServerTimeSec, toNum } = require('../utils/utils');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { getBag, getBagItems, isItemLocked } = require('./warehouse');
const { invalidateActivityWindows } = require('./activity-windows');
const { checkCanShare, reportActivityShare } = require('./share');

const SERVICE = 'gamepb.activitypb.ActivityService';
const MAPLE_MARKET_SHARE_SOURCE = 28;
const MAPLE_MARKET_SHARE_SCENE = 2017;
const { groupId, activityId, seedItemId, cropItemId, coinItemId } = config;
const goodsById = new Map(config.goods.map(goods => [goods.id, goods]));
const sortedPriceTiers = [...config.priceTiers].sort((a, b) => a.min - b.min);

const operations = {
    claimSeed: { cmd: 91, field: 'maple_market_claim_seed', hasReqBody: true },
    getShop: { cmd: 92, field: 'maple_market_get_shop', hasReqBody: true },
    sell: { cmd: 93, field: 'maple_market_sell', hasReqBody: true },
    getPurchaseLog: { cmd: 95, field: 'maple_market_get_purchase_log', hasReqBody: true },
    exchange: { cmd: 96, field: 'maple_market_exchange', hasReqBody: true },
    getGoods: { cmd: 97, field: 'maple_market_get_goods_list', hasReqBody: true },
    shareBoost: { cmd: 98, field: 'maple_market_share_boost', hasReqBody: true },
    claimCommission: { cmd: 99, field: 'maple_market_claim_commission', hasReqBody: false },
} as const;

let mutationTail: Promise<any> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = mutationTail.then(fn, fn);
    mutationTail = run.then(() => {}, () => {});
    return run;
}

export interface MapleMarketQuote {
    basePrice: number;
    boost: number;
    unitPrice: number;
    priceRateBp: number;
    complete: boolean;
    tier: string | null;
    canSell: boolean;
    remainingQuota: number;
    ownerName: string;
}

function fail(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
}

function resolvePriceTier(price: number): string | null {
    if (!Number.isFinite(price) || price <= 0 || !sortedPriceTiers.length) return null;
    const exact = sortedPriceTiers.find(entry => entry.min <= price && price <= entry.max);
    if (exact) return exact.name;
    let fallback = sortedPriceTiers[0];
    for (const entry of sortedPriceTiers) {
        if (price < entry.min) break;
        fallback = entry;
    }
    return fallback?.name || null;
}

function parseRules(extra: unknown): string[] {
    if (!extra || !(extra instanceof Uint8Array) || !extra.length) return [];
    try {
        const parsed = JSON.parse(Buffer.from(extra).toString('utf8'));
        if (!Array.isArray(parsed?.tips?.txt)) return [];
        return parsed.tips.txt
            .map((line: unknown) => String(line).replace(/<[^>]+>/g, '').trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

async function readMarketState() {
    const request = types.GetGroupRequest.encode({ group_id: groupId }).finish();
    const response = await sendMsgAsync(SERVICE, 'GetGroup', request);
    const { group } = types.GetGroupReply.decode(response.body);
    const node = group?.children.find((child: any) => String(child.activity?.activity_id) === activityId);
    if (String(group?.activity?.activity_id) !== groupId || !node?.maple_market) {
        fail('MAPLE_MARKET_UNAVAILABLE', '以薯换福活动数据暂不可用');
    }

    const head = node.activity;
    const market = node.maple_market;
    const now = getServerTimeSec();
    const start = toNum(head.begin_time);
    const end = toNum(head.end_time);
    const settle = toNum(head.settle_start_time);
    const phase = now < start ? 'upcoming'
        : now > end ? 'ended'
            : settle > 0 && now >= settle ? 'settlement'
                : toNum(head.field_20) === 1 ? 'active' : 'unavailable';
    const seedClaimed = market.daily_state?.seed_claimed === true;
    const canClaimSeed = phase === 'active' && !seedClaimed && market.red_dots?.seed_unclaimed === true;
    const shared = market.daily_state?.shared === true;
    const canShare = phase === 'active' && !shared && market.red_dots?.share_unclaimed === true;
    const pendingCommissionCoin = toNum(market.pending_commission_coin);
    const pendingCommissionCount = toNum(market.pending_commission_count);
    const canClaimCommission = (phase === 'active' || phase === 'settlement') && pendingCommissionCoin > 0;
    return {
        priceRateBp: toNum(market.price_rate_bp),
        progress: {
            activityId: groupId,
            serverTime: now * 1000,
            startTime: start * 1000,
            endTime: end * 1000,
            phase,
            seedClaimed,
            canClaimSeed,
            seedItemId,
            cropItemId,
            coinItemId,
            shared,
            canShare,
            coinBalance: toNum(market.activity_coin),
            pendingCommissionCoin,
            pendingCommissionCount,
            canClaimCommission,
            purchaseLogUnread: market.red_dots?.purchase_log_unread === true,
            rules: parseRules(head.extra),
        },
    };
}

async function getMarketProgress() {
    const { progress } = await readMarketState();
    return progress;
}

async function operate(action: keyof typeof operations, params: Record<string, unknown> = {}) {
    const { cmd, field, hasReqBody } = operations[action];
    const payload = hasReqBody ? { id: activityId, cmd, [field]: params } : { id: activityId, cmd };
    const request = types.MapleMarketOperateRequest.encode(payload).finish();
    const writes = action === 'claimSeed' || action === 'shareBoost' || action === 'sell' || action === 'exchange' || action === 'claimCommission';
    const response = await sendMsgAsync(SERVICE, 'Operate', request);
    const reply = types.ActivityOperateReply.decode(response.body);
    if (String(reply.activity_id) !== activityId || toNum(reply.operate_type) !== cmd
        || String(reply.data?.activity?.activity_id) !== activityId || !reply[field]) {
        if (writes) fail('MAPLE_MARKET_RESULT_UNKNOWN', '操作结果待核对，请刷新活动状态');
        fail('MAPLE_MARKET_UNAVAILABLE', '以薯换福返回的数据不完整，请刷新重试');
    }
    return { result: reply[field], market: reply.data.maple_market };
}

async function getOwnShopQuote(fallbackRateBp = 0): Promise<MapleMarketQuote> {
    const { result, market } = await operate('getShop', { target_gid: getUserState().gid });
    if (!result.shop) {
        fail('MAPLE_MARKET_UNAVAILABLE', '当前收购价暂不可用');
    }
    const basePrice = toNum(result.shop.base_price);
    const boost = toNum(result.shop.boost_value);
    const unitPrice = basePrice + boost;
    const priceRateBp = toNum(market?.price_rate_bp) || fallbackRateBp;
    return {
        basePrice,
        boost,
        unitPrice,
        priceRateBp,
        complete: basePrice > 0 && boost > 0,
        tier: resolvePriceTier(unitPrice),
        canSell: result.can_sell === true,
        remainingQuota: toNum(result.shop.remain_quota),
        ownerName: String(result.shop.owner?.name || '').trim(),
    };
}

function stock(items: any[], itemId: number) {
    return items.reduce((total: number, item: any) => (
        toNum(item.id) === itemId ? total + toNum(item.count) : total
    ), 0);
}

function sellableStock(items: any[]) {
    return stock(items.filter(item => !isItemLocked(item)), cropItemId);
}

async function getCatalog() {
    const { result } = await operate('getGoods');
    const goods = result.goods.map((row: any) => {
        const id = toNum(row.goods_id);
        const definition = goodsById.get(id);
        const limitType = toNum(row.limit_type);
        const purchased = toNum(limitType === 1 ? row.purchased_daily : row.purchased_total);
        const limitTimes = limitType > 0 ? toNum(row.limit_times) : null;
        const items = definition?.items.map((item) => {
            const info = getItemById(item.id);
            const description = String(info?.desc || info?.effectDesc || '').trim();
            return {
                ...item,
                name: info?.name || `物品 #${item.id}`,
                image: getItemImageById(item.id),
                ...(description ? { description } : {}),
            };
        }) || [];
        const description = items
            .map((item: { description?: string }) => item.description || '')
            .filter(Boolean)
            .join('\n');
        return {
            id,
            name: definition?.name || `商品 #${id}`,
            items,
            ...(description ? { description } : {}),
            price: toNum(row.activity_coin_price),
            limitType,
            limitTimes,
            remaining: limitTimes !== null ? Math.max(0, limitTimes - purchased) : null,
            exchangeable: !!definition && row.exchangeable === true,
        };
    });
    return { goods, coinBalance: toNum(result.activity_coin) };
}

async function getMapleMarketActivity() {
    const { progress, priceRateBp } = await readMarketState();
    const open = progress.phase === 'active' || progress.phase === 'settlement';
    const [quote, catalog, bag] = await Promise.all([
        progress.phase === 'active' ? getOwnShopQuote(priceRateBp) : null,
        open ? getCatalog() : null,
        open ? getBag() : null,
    ]);
    const bagItems = bag ? getBagItems(bag) : [];
    const cropStock = stock(bagItems, cropItemId);
    const sellableCropStock = sellableStock(bagItems);
    return {
        ...progress,
        coinBalance: catalog?.coinBalance ?? progress.coinBalance,
        quote,
        goods: catalog?.goods ?? [],
        seedStock: stock(bagItems, seedItemId),
        cropStock,
        sellableCropStock,
    };
}

async function claimMapleMarketSeed() {
    return withWriteLock(async () => {
        const progress = await getMarketProgress();
        if (!progress.canClaimSeed) {
            return {
                status: 'skipped' as const,
                data: null,
                message: progress.seedClaimed ? '今日红薯种子已领取' : '当前没有可领取的红薯种子',
            };
        }
        const { result, market } = await operate('claimSeed');
        const id = toNum(result.seed?.id);
        const count = toNum(result.seed?.count);
        if (id !== seedItemId || count <= 0 || market?.daily_state?.seed_claimed !== true) {
            fail('MAPLE_MARKET_RESULT_UNKNOWN', '领种结果待核对，请刷新活动状态');
        }
        invalidateActivityWindows();
        return {
            status: 'confirmed' as const,
            data: { activityId: groupId, seed: { id, count, name: '红薯种子' } },
        };
    });
}

async function shareMapleMarketBoost() {
    return withWriteLock(async () => {
        const progress = await getMarketProgress();
        if (!progress.canShare) {
            return {
                status: 'skipped' as const,
                data: null,
                message: progress.shared ? '今日分享暴击已触发' : '当前不可触发分享暴击',
            };
        }
        const { result, market } = await operate('shareBoost');
        const boost = toNum(result.boost_value);
        const finalPrice = toNum(result.final_price);
        const priceRateBp = toNum(result.price_rate_bp);
        const seedId = toNum(result.seed?.id);
        const seedCount = toNum(result.seed?.count);
        if (market?.daily_state?.shared !== true || boost <= 0 || finalPrice <= 0 || toNum(market.boost_value) !== boost) {
            fail('MAPLE_MARKET_RESULT_UNKNOWN', '分享暴击结果待核对，请刷新活动状态');
        }
        try {
            const shareStatus = await checkCanShare();
            if (shareStatus?.can_share !== false) {
                await reportActivityShare(MAPLE_MARKET_SHARE_SOURCE, MAPLE_MARKET_SHARE_SCENE);
            }
        } catch {
            // Operate(cmd=98) 已在服务端落账；分享统计上报异常不得把已生效结果误判为 unknown。
        }
        invalidateActivityWindows();
        return {
            status: 'confirmed' as const,
            data: {
                activityId: groupId,
                boost,
                finalPrice,
                priceRateBp,
                seed: seedId === seedItemId && seedCount > 0 ? { id: seedId, count: seedCount, name: '红薯种子' } : null,
            },
        };
    });
}

async function claimMapleMarketCommission() {
    return withWriteLock(async () => {
        const progress = await getMarketProgress();
        if (!progress.canClaimCommission) {
            return { status: 'skipped' as const, data: null, message: '当前没有可领取的小铺提成' };
        }
        const { result, market } = await operate('claimCommission');
        const claimedCoin = toNum(result.claimed_coin);
        const claimedCount = toNum(result.claimed_count);
        const coinBalance = toNum(result.activity_coin);
        if (claimedCoin <= 0 || claimedCount <= 0 || !market
            || toNum(market.activity_coin) !== coinBalance
            || coinBalance < claimedCoin
            || toNum(market.pending_commission_coin) !== 0) {
            fail('MAPLE_MARKET_RESULT_UNKNOWN', '提成领取结果待核对，请刷新活动状态');
        }
        invalidateActivityWindows();
        return {
            status: 'confirmed' as const,
            data: { activityId: groupId, claimedCoin, claimedCount, coinBalance },
        };
    });
}

async function sellMapleMarketCrop(count: number, expectedUnitPrice: number) {
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(expectedUnitPrice) || expectedUnitPrice < 1) {
        fail('INVALID_MAPLE_MARKET_SALE', '请填写有效的出售数量和收购价');
    }
    return withWriteLock(async () => {
        const progress = await getMarketProgress();
        if (progress.phase !== 'active') {
            fail('MAPLE_MARKET_SALE_UNAVAILABLE', '当前阶段无法出售蜜薯');
        }
        const gid = getUserState().gid;
        const [bag, quote] = await Promise.all([getBag({ fresh: true }), getOwnShopQuote()]);
        if (!quote.canSell) {
            fail('MAPLE_MARKET_SALE_UNAVAILABLE', '当前小铺无法收购蜜薯');
        }
        if (quote.unitPrice !== expectedUnitPrice) {
            fail('MAPLE_MARKET_PRICE_CHANGED', '收购价已变化，请刷新确认');
        }
        if (count > sellableStock(getBagItems(bag))) {
            fail('MAPLE_MARKET_STOCK_CHANGED', '可用蜜薯不足，请刷新库存');
        }

        const { result, market } = await operate('sell', { target_gid: gid, sell_count: count });
        const sold = toNum(result.sold_count);
        const unitPrice = toNum(result.final_price);
        const income = toNum(result.activity_coin_income);
        const coinBalance = toNum(result.activity_coin);
        if (sold !== count || unitPrice <= 0 || income !== sold * unitPrice
            || !market || toNum(market.activity_coin) !== coinBalance || coinBalance < income) {
            fail('MAPLE_MARKET_RESULT_UNKNOWN', '出售结果待核对，请刷新活动状态');
        }
        return { sold, unitPrice, income, coinBalance };
    });
}

async function exchangeMapleMarketGoods(goodsId: number, count: number, expectedUnitPrice: number) {
    if (!Number.isSafeInteger(goodsId) || goodsId < 1 || !Number.isSafeInteger(count) || count < 1
        || !Number.isSafeInteger(expectedUnitPrice) || expectedUnitPrice < 1) {
        fail('INVALID_MAPLE_MARKET_EXCHANGE', '请确认有效的兑换商品、数量和价格');
    }
    return withWriteLock(async () => {
        const progress = await getMarketProgress();
        if (progress.phase !== 'active' && progress.phase !== 'settlement') {
            fail('MAPLE_MARKET_EXCHANGE_UNAVAILABLE', '当前阶段无法兑换商品');
        }
        const catalog = await getCatalog();
        const offer = catalog.goods.find((goods: { id: number }) => goods.id === goodsId);
        if (!offer?.exchangeable) {
            fail('MAPLE_MARKET_EXCHANGE_UNAVAILABLE', '该商品当前无法兑换');
        }
        if (offer.price !== expectedUnitPrice) {
            fail('MAPLE_MARKET_PRICE_CHANGED', '商品价格已变化，请刷新确认');
        }
        if (offer.remaining !== null && count > offer.remaining) {
            fail('MAPLE_MARKET_GOODS_LIMIT', '兑换数量超过剩余限购');
        }
        const cost = count * offer.price;
        if (cost > catalog.coinBalance) {
            fail('MAPLE_MARKET_COIN_INSUFFICIENT', '可用福气币不足');
        }

        const { result, market } = await operate('exchange', { goods_id: goodsId, exchange_count: count });
        const items = result.items;
        const coinBalance = toNum(result.activity_coin);
        const purchasedAfter = offer.limitType === 1 ? toNum(result.purchased_daily) : toNum(result.purchased_total);
        const remaining = offer.limitTimes !== null
            ? (purchasedAfter > 0 ? Math.max(0, offer.limitTimes - purchasedAfter) : Math.max(0, (offer.remaining ?? offer.limitTimes) - count))
            : null;
        const received = new Map<number, number>();
        for (const item of items) {
            const id = toNum(item.id);
            received.set(id, (received.get(id) || 0) + toNum(item.count));
        }
        if (toNum(result.activity_coin_cost) !== cost || !market || toNum(market.activity_coin) !== coinBalance
            || received.size !== offer.items.length
            || !offer.items.every((item: { id: number; count: number }) => received.get(item.id) === item.count * count)) {
            fail('MAPLE_MARKET_RESULT_UNKNOWN', '兑换结果待核对，请刷新活动状态');
        }
        return {
            goodsId,
            count,
            cost,
            coinBalance,
            remaining,
            items: offer.items.map((item: { id: number; count: number; name: string }) => ({
                ...item,
                count: item.count * count,
            })),
        };
    });
}

async function getMapleMarketPurchaseLog() {
    const progress = await getMarketProgress();
    if (progress.phase !== 'active' && progress.phase !== 'settlement') {
        fail('MAPLE_MARKET_UNAVAILABLE', '当前阶段暂无收购记录');
    }
    const { result } = await operate('getPurchaseLog');
    const records = (result.records || [])
        .map((row: any) => {
            const sellerGid = toNum(row.seller_gid);
            return {
                timestamp: toNum(row.timestamp) * 1000,
                sellerGid,
                sellerName: String(row.seller_name || '').trim() || `GID:${sellerGid}`,
                sellerAvatar: String(row.seller_avatar || ''),
                sellerLevel: toNum(row.seller_level),
                soldCount: toNum(row.sold_count),
                income: toNum(row.income),
                commission: toNum(row.commission),
            };
        })
        .sort((a: { timestamp: number }, b: { timestamp: number }) => b.timestamp - a.timestamp);
    return { records };
}

module.exports = {
    getMapleMarketActivity,
    getMapleMarketPurchaseLog,
    claimMapleMarketSeed,
    shareMapleMarketBoost,
    claimMapleMarketCommission,
    sellMapleMarketCrop,
    exchangeMapleMarketGoods,
};

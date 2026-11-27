<script setup lang="ts">
import { onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'

const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const message = ref('')
const error = ref('')
const testTo = ref('')

const form = ref({
  host: 'smtp.qq.com',
  port: 465,
  secure: true,
  user: '',
  fromName: 'QQ农场 Bot',
  pass: '',
  hasPass: false,
})

const PRESETS = [
  { label: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, secure: true },
  { label: '163 邮箱', host: 'smtp.163.com', port: 465, secure: true },
  { label: '126 邮箱', host: 'smtp.126.com', port: 465, secure: true },
  { label: '腾讯企业邮', host: 'smtp.exmail.qq.com', port: 465, secure: true },
  { label: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: true },
]

function applyPreset(preset: typeof PRESETS[number]) {
  form.value.host = preset.host
  form.value.port = preset.port
  form.value.secure = preset.secure
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await api.get('/api/admin/smtp')
    if (data?.ok) {
      form.value = { ...form.value, ...data.data, pass: '' }
      testTo.value = form.value.user || ''
    }
    else {
      error.value = getApiErrorMessage(data, '读取 SMTP 配置失败')
    }
  }
  catch (e: any) {
    error.value = getApiErrorMessage(e, '读取 SMTP 配置失败')
  }
  finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  message.value = ''
  error.value = ''
  try {
    const payload: any = {
      host: form.value.host.trim(),
      port: Number(form.value.port) || 465,
      secure: form.value.secure,
      user: form.value.user.trim(),
      fromName: form.value.fromName.trim(),
    }
    if (form.value.pass.trim())
      payload.pass = form.value.pass.trim()
    const { data } = await api.post('/api/admin/smtp', payload)
    if (data?.ok) {
      form.value = { ...form.value, ...data.data, pass: '' }
      message.value = data.message || 'SMTP 配置已保存'
    }
    else {
      error.value = getApiErrorMessage(data, '保存失败')
    }
  }
  catch (e: any) {
    error.value = getApiErrorMessage(e, '保存失败')
  }
  finally {
    saving.value = false
  }
}

async function sendTest() {
  if (!testTo.value.trim()) {
    error.value = '请填写测试收件邮箱'
    return
  }
  testing.value = true
  message.value = ''
  error.value = ''
  try {
    const { data } = await api.post('/api/admin/smtp/test', { to: testTo.value.trim() })
    if (data?.ok)
      message.value = data.message || '测试邮件已发送'
    else
      error.value = getApiErrorMessage(data, '发送失败')
  }
  catch (e: any) {
    error.value = getApiErrorMessage(e, '发送失败')
  }
  finally {
    testing.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="farm-card rounded-lg p-4">
    <div class="mb-4 flex items-start gap-3">
      <div class="h-9 w-9 flex shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-900/25 dark:text-emerald-400">
        <span class="i-carbon-email text-xl" />
      </div>
      <div>
        <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
          邮件服务（SMTP）
        </h4>
        <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          全局发件配置，所有「邮箱」推送渠道都使用这里的发件邮箱。
        </p>
      </div>
    </div>

    <div class="mb-3 flex flex-wrap gap-2">
      <button
        v-for="preset in PRESETS"
        :key="preset.host"
        type="button"
        class="rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:border-emerald-400 hover:text-emerald-600 dark:border-gray-700 dark:text-gray-300"
        @click="applyPreset(preset)"
      >
        {{ preset.label }}
      </button>
    </div>

    <div v-if="loading" class="py-4 text-center text-sm text-gray-500">
      加载中…
    </div>
    <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <BaseInput v-model="form.host" label="SMTP 服务器" type="text" placeholder="smtp.qq.com" />
      <BaseInput v-model.number="form.port" label="端口" type="number" placeholder="465" />
      <BaseInput v-model="form.user" label="发件邮箱" type="text" placeholder="your@qq.com" />
      <BaseInput
        v-model="form.pass"
        :label="form.hasPass ? '授权码（留空则不修改）' : '授权码 / 密码'"
        type="password"
        placeholder="邮箱客户端授权码，不是登录密码"
      />
      <BaseInput v-model="form.fromName" label="发件人名称" type="text" placeholder="QQ农场 Bot" />
      <div class="flex items-end pb-1">
        <BaseSwitch v-model="form.secure" label="SSL 加密（465 端口开启）" />
      </div>
    </div>

    <p class="mt-2 text-xs text-gray-500 leading-relaxed dark:text-gray-400">
      QQ / 163 邮箱需要在网页端开启 SMTP 服务并生成“授权码”；587 端口请关闭 SSL。
    </p>

    <div v-if="message" class="mt-3 rounded-md bg-green-50 px-3 py-2 text-xs text-green-700 dark:bg-green-900/20 dark:text-green-300">
      {{ message }}
    </div>
    <div v-if="error" class="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-300">
      {{ error }}
    </div>

    <div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3 dark:border-gray-700">
      <div class="flex items-center gap-2">
        <BaseInput v-model="testTo" placeholder="测试收件邮箱" type="text" />
        <BaseButton variant="secondary" size="sm" :loading="testing" @click="sendTest">
          发送测试邮件
        </BaseButton>
      </div>
      <BaseButton variant="primary" size="sm" :loading="saving" @click="save">
        保存 SMTP
      </BaseButton>
    </div>
  </section>
</template>

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

import App from './App.vue'
import router from './router'

import './styles/index.css'

const app = createApp(App)

// Element Plus：全局注册组件 + 中文语言包
app.use(ElementPlus, { locale: zhCn })

// 图标全局注册，模板中可直接 <el-icon><Search /></el-icon>
for (const [name, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(name, component)
}

app.use(createPinia())
app.use(router)

app.mount('#app')

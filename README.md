# 信封记账

按发薪周期记账的网页 App。信封花钱、排表攒钱、付不齐会预警。

**试用中。** 账目只存在你自己的手机浏览器里，仓库里没有任何真实数据。

## 用法

打开 [首页](https://q1827965-lab.github.io/jizhang/) ，用手机浏览器打开后「添加到主屏幕」，就能像 App 一样用，断网也能打开。

第一次用先去「更多 → 导入 JSON」把账导进来。

## 隐私

- 账目存在浏览器的 localStorage，**不上传任何服务器**
- 这个仓库是纯代码，没有账号、没有后端、没有数据收集
- 清理浏览器数据 / 换手机 / 卸载重装都会丢，**记得定期在「更多 → 导出 JSON 备份」**

## 源码结构

```
index.html            入口（跳转首页）
manifest.webmanifest  PWA 配置（添加到主屏幕）
sw.js                 Service Worker（离线可用、新版本提示）
js/calc.js            纯计算层（不知道存储的存在）
js/store.js           数据层（唯一碰 localStorage 的地方）
js/ui.js              渲染 + PWA 启动
js/png-data.js        图标 PNG 的 base64（运行时转成 blob）
css/app.css
pages/*.html          13 个页面
icons/*.svg           4 个图标（含 2 个 maskable）
```

数据版本号：`js/store.js` 里的 `SCHEMA_VERSION`。

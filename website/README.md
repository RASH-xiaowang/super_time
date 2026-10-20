# website/ 静态站点

GitHub Pages 直接发布本目录（见 `.github/workflows/pages.yml`，会先 `rsync --exclude 'tests/'`）。

## 微信二维码

「联系我们」版块引用 `wechat-qr.png`（相对路径，与 `index.html` 同级）。

**放置方式**：把微信二维码图片命名为 `wechat-qr.png` 放进本目录即可，无需改 HTML。

- 建议尺寸：**正方形**，≥ 400×400（页面按 132×132 显示，留 2 倍余量给高分屏）
- 建议格式：PNG（带白底，页面会给它加白色圆角底衬）
- 图片缺失时页面会显示「二维码待放入」占位框，不会破版

## 本地预览

直接双击 `index.html` 即可（纯静态，无构建步骤）。

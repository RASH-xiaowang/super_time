# Whisper 引擎与预置模型（随包分发的只读源）

本目录是**随包分发的只读资产**：界面【数据配置】→「语音转写」里「模型目录」留空时的默认值
**不是这里**，而是**数据根下的可写目录** `<数据根>/whisper`：

- 开发态：`%APPDATA%\super-time-electron\wechat-data\whisper`
- 安装版：`%APPDATA%\Super Time\wechat-data\whisper`

首次使用时会先把本目录里的引擎与预置模型**镜像**进那个可写目录（同卷硬链接、跨卷才真复制），
此后安装目录只被读取；要换别的模型就下载到可写目录里。镜像失败（userData 不可写等）时才退回本目录。

本目录内容（打包态位于 `app.asar.unpacked/wechat/whisper`，见 `package.json` 的 `asarUnpack`）：

```
wechat/whisper/ggml-tiny.bin              预置模型（约 75 MB）
wechat/whisper/bin/whisper-cli.exe        whisper.cpp 引擎（只认识这个文件名）
wechat/whisper/bin/*.dll                  whisper.dll / ggml.dll / ggml-base.dll / 各 CPU 后端
```

为什么运行时不直接用本目录：安装版装到 `Program Files` 时没有写权限，而「下载其它模型」
「重装引擎」都要往模型目录里写；写在安装目录里还会把本机绝对路径随包带到别的电脑上
（见 [../README.md](../README.md) 里「运行时绝不往这里写文件」那一节）。

const { app, BrowserWindow, ipcMain, shell} = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

// --- 1. 核心逻辑：定义资源根目录 ---
// 如果是打包后(isPackaged=true)，去 Resources 文件夹找
// 如果是开发时(isPackaged=false)，去上一级目录(项目根目录)找
const baseResourcePath = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '..');

  // 🔥 修改点 A: 增加获取引擎路径的函数，支持多架构
function getWhisperPath() {
    const arch = process.arch; // 'x64' (Intel) 或 'arm64' (M1/M2)
    const platform = process.platform;

    if (platform === 'win32') {
        return path.join(baseResourcePath, 'bin', 'whisper-win-x64.exe');
    }

    if (platform === 'darwin') {
        // ✨ 如果是 ARM64 (M1/M2/M3)，去找专门的 arm64 文件
        // 如果是 X64 (Intel)，去找旧的 x64 文件
        const binaryName = (arch === 'arm64') ? 'whisper-mac-arm64' : 'whisper-mac-x64';
        return path.join(baseResourcePath, 'bin', binaryName);
    }

    return path.join(baseResourcePath, 'bin', 'whisper-mac-x64'); // 默认兜底
}

// --- 2. 拼接具体文件的路径 ---
const ffmpegPath = path.join(baseResourcePath, 'bin', 'ffmpeg');

// 🔥 核心修改：不要写死 'whisper-mac-x64'，而是调用函数动态获取！
const whisperPath = getWhisperPath();

const modelPath = path.join(baseResourcePath, 'models', 'ggml-base.bin');

// 🛡️【权限修复】: 确保文件有执行权限 (解决 macOS EACCES 报错)
if (process.platform === 'darwin') {
  try {
    // 定义两个具体的路径，不管当前用哪个，把两个都赋权，以防万一
    const x64Path = path.join(baseResourcePath, 'bin', 'whisper-mac-x64');
    const arm64Path = path.join(baseResourcePath, 'bin', 'whisper-mac-arm64');

    // 遍历这三个文件，只要存在的，统统给 755 权限
    [ffmpegPath, x64Path, arm64Path].forEach(p => {
        if (fs.existsSync(p)) {
            fs.chmodSync(p, 0o755); // 0o755 代表 rwxr-xr-x (拥有者可执行)
            console.log(`✅ 权限修复成功: ${path.basename(p)}`);
        }
    });
  } catch (err) {
    console.error('⚠️ 赋予权限失败:', err.message);
  }
}

// 禁用 Electron 自身的 GPU 加速 (解决 UI 卡顿，不影响 Whisper)
app.disableHardwareAcceleration();

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 700,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        }
    });
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
    createWindow();
// 🔥 修改点 3: macOS 专属逻辑 - 点击图标重新打开窗口
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// 🔥 核心修改：接收前端传来的 lang 参数 (默认 'cn')
ipcMain.on('start-transcription', async (event, filePath, lang = 'cn') => {
    if (!filePath) {
        console.error("❌ 错误：接收到的 filePath 为空！");
        event.reply('transcription-data', "❌ 错误：无法获取文件路径，请重试。\n");
        return; // 直接结束，不再往下跑，防止报错崩溃
    }
    // --- 🌐 后台多语言字典 ---
    const i18nLog = {
        cn: {
            analyzing: "🚀 正在分析系统环境...",
            gpu_m1: "检测到 Apple Silicon (M1/M2/M3)，启用 Metal GPU 加速！⚡️",
            cpu_intel: "检测到 Intel Mac，自动切换至 CPU 多线程稳定模式 (防止乱码)。🛡️",
            non_mac: "检测到非 macOS 系统，使用默认加速策略。",
            ffmpeg_fail: "❌ 转码失败，请检查文件格式。",
            ffmpeg_start: "❌ FFmpeg 启动失败: ",
            done: "🎉 完成！",
            result_label: "📄 结果: ",
            error_label: "⚠️ 异常结束 (代码 "
        },
        en: {
            analyzing: "🚀 Analyzing system environment...",
            gpu_m1: "Detected Apple Silicon (M1/M2/M3). Metal GPU acceleration enabled! ⚡️",
            cpu_intel: "Detected Intel Mac. Switching to CPU multi-thread stable mode to prevent errors. 🛡️",
            non_mac: "Non-macOS system detected. Using default strategy.",
            ffmpeg_fail: "❌ Transcoding failed. Please check file format.",
            ffmpeg_start: "❌ FFmpeg failed to start: ",
            done: "🎉 Finished!",
            result_label: "📄 Result: ",
            error_label: "⚠️ Error (Code "
        }
    };

    // 获取当前语言包
    const t = i18nLog[lang] || i18nLog.cn;
    const timestamp = Date.now();
    const tempWavPath = path.join(os.tmpdir(), `temp_${timestamp}.wav`);

    // 1. 获取系统下载文件夹路径
    const downloadsPath = app.getPath('downloads');
	const fileName = path.basename(filePath, path.extname(filePath)); // 原文件名
    // 2. 将结果文件前缀设为下载文件夹
    const outputPrefix = path.join(downloadsPath, `trans_result_${timestamp}`);

    event.reply('transcription-data', `${t.analyzing}\n`);

    // --- 🔍 智能硬件检测逻辑 ---
    const isMac = process.platform === 'darwin';
    const arch = process.arch; // 'x64' 是 Intel, 'arm64' 是 M1/M2

    let useGPU = true; // 默认大家都想用 GPU
    let hardwareMsg = "";

    if (isMac) {
        if (arch === 'arm64') {
            // M1/M2/M3: 天生强大，直接用 GPU (Metal)
            useGPU = true;
            hardwareMsg = t.gpu_m1;
        } else {
            // Intel Mac: 显卡计算半精度会出错导致乱码，必须强制用 CPU
            useGPU = false;
            hardwareMsg = t.cpu_intel;
        }
    } else {
        hardwareMsg = t.non_mac;
    }

    console.log(`【系统检测】架构: ${arch}, 策略: ${hardwareMsg}`);
    event.reply('transcription-data', `${hardwareMsg}\n`);

    // --- 步骤 1: FFmpeg 转码 ---
    const ffmpegArgs = [
        '-i', filePath,
        '-ar', '16000', // ⚠️ 采样率必须是 16000
        '-ac', '1',     // ⚠️ 必须是单声道
        '-c:a', 'pcm_s16le',
        '-y',
        tempWavPath
    ];

    const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
    // ffmpeg.stderr.on('data', (data) => console.log(`[FFmpeg]: ${data}`)); // 调试时可开启

    ffmpeg.on('error', (err) => {
        event.reply('transcription-data', `${t.ffmpeg_start}${err.message}\n`);
    });

    ffmpeg.on('close', async (code) => {
        if (code !== 0) {
            event.reply('transcription-data', `${t.ffmpeg_fail}\n`);
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 500));

        // --- 步骤 2: Whisper 识别 ---
        const whisperArgs = [
            '-m', modelPath,
            '-f', tempWavPath,
            '-l', 'auto',

            // ✅ 优化点：Intel Mac 需要多线程来弥补没有 GPU 的速度
            // M1 也可以给 4 线程辅助
            '-t', isMac && arch !== 'arm64' ? '8' : '4',

            // ❌ 务必删掉 '--print-colors' (解决字幕文件打不开的问题)
            '--print-progress', // 保留进度条

            '-otxt',
            '-osrt',
            '-of', outputPrefix,
        ];

        // 🔥【关键修正】如果检测到是 Intel Mac (useGPU=false)，强制插入 -ng 参数
        if (!useGPU) {
            whisperArgs.push('-ng');
            console.log("已添加 -ng 参数 (禁用 GPU)");
        }

        console.log("执行 Whisper 命令:", whisperArgs.join(" "));

        const whisper = spawn(whisperPath, whisperArgs);

        whisper.stdout.on('data', (data) => {
            event.reply('transcription-data', data.toString());
        });

        whisper.stderr.on('data', (data) => {
            const text = data.toString();
            // 捕捉类似 "progress = 25%" 的字样
            const match = text.match(/progress\s*=\s*(\d+)%/);
            if (match) {
                const percentage = match[1];
                event.reply('transcription-progress', percentage); // 单独发一个进度事件
            }
        });

        whisper.on('close', (code) => {
            if (code === 0) {
                // 🔥 修改点 4: 读取生成的文件内容，并自动打开文件夹
                const resultTxtPath = outputPrefix + '.txt';
                let finalContent = "";

                try {
                    if (fs.existsSync(resultTxtPath)) {
                        // 1. 读取内容发给前端显示
                        finalContent = fs.readFileSync(resultTxtPath, 'utf-8');
                        // 2. 告诉前端：这是最终结果，请替换掉之前的日志
                        event.reply('transcription-data', `\n✅ --------------------\n${finalContent}\n--------------------\n`);

                        // 3. 弹窗打开文件夹，选中该文件
                        shell.showItemInFolder(resultTxtPath);
                        event.reply('transcription-data', `${t.done}\n${t.result_label}${resultTxtPath}\n`);
                    }
                } catch (e) {
                    console.error("读取结果失败", e);
                }
				event.reply('transcription-finished');
            } else {
                event.reply('transcription-data', `\n${t.error_label}${code})\n`);
            }
        });
    });
});

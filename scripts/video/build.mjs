#!/usr/bin/env node

// Rebuilds the explainer video, captions and README GIF. Needs macOS (say, Chrome at the fixed path below),
// ffmpeg and Node 22+ (global WebSocket). Writes assets/agentpack-explainer.mp4, .vtt and assets/demo.gif.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureSession } from "./capture.mjs";
import { GAPS, SCENES, SPEECH_RATE, VOICES } from "./script.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const buildDir = path.join(here, "build");
const cliPath = path.join(repoRoot, "dist", "src", "agentpack.js");
const assetsDir = path.join(repoRoot, "assets");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FPS = 30;
const GIF_FPS = 12;
const GIF_LIMIT_BYTES = 2_000_000;

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

async function main() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(path.join(buildDir, "audio"), { recursive: true });
  mkdirSync(path.join(buildDir, "stills"), { recursive: true });

  console.log("Building the CLI");
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });

  console.log("Capturing real Agentpack output");
  const captured = await captureSession(cliPath);
  writeFileSync(path.join(buildDir, "captured.json"), JSON.stringify(captured, null, 2));

  const voice = pickVoice();
  console.log(`Narrating with voice: ${voice}`);
  const narrated = narrate(voice);
  const timeline = buildTimeline(narrated);
  const total = timeline.total;

  const page = { timeline, captured, total };
  const videoOnly = path.join(buildDir, "video-only.mp4");
  await renderVideo(page, videoOnly);

  const audio = path.join(buildDir, "narration.wav");
  mixAudio(timeline, total, audio);

  const mp4 = path.join(assetsDir, "agentpack-explainer.mp4");
  run("ffmpeg", ["-y", "-i", videoOnly, "-i", audio, "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-t", total.toFixed(3), "-movflags", "+faststart", mp4]);

  const vtt = path.join(assetsDir, "agentpack-explainer.vtt");
  writeFileSync(vtt, toVtt(timeline.cues));

  const gif = path.join(assetsDir, "demo.gif");
  const gifRange = { start: timeline.scenes[3].start + 0.5, end: timeline.scenes[4].end - 0.3 };
  const gifSettings = await renderGif(page, gif, gifRange);

  summarize({ voice, mp4, vtt, gif, gifSettings, timeline });
}

function run(command, args) {
  return execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }).toString();
}

function duration(file) {
  return Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim());
}

function streamDuration(file, selector) {
  return Number(run("ffprobe", ["-v", "error", "-select_streams", selector, "-show_entries", "stream=duration", "-of", "default=nw=1:nk=1", file]).trim());
}

function pickVoice() {
  const installed = run("say", ["-v", "?"]);
  const voice = VOICES.find((name) => installed.split("\n").some((line) => line.startsWith(`${name} `)));
  if (!voice) throw new Error(`None of the voices are installed: ${VOICES.join(", ")}`);
  return voice;
}

function narrate(voice) {
  return SCENES.map((scene, s) => ({
    ...scene,
    lines: scene.lines.map((text, l) => {
      const file = path.join(buildDir, "audio", `s${s + 1}-l${l + 1}.aiff`);
      run("say", ["-v", voice, "-r", String(SPEECH_RATE), "-o", file, text]);
      return { text, file, length: duration(file) };
    })
  }));
}

function buildTimeline(narrated) {
  const scenes = [];
  const clips = [];
  const cues = [];
  let cursor = 0;
  narrated.forEach((scene, index) => {
    const isLast = index === narrated.length - 1;
    let at = cursor + scene.lead;
    const lines = scene.lines.map((line) => {
      const placed = { text: line.text, start: at, end: at + line.length };
      clips.push({ file: line.file, start: placed.start });
      cues.push({ text: line.text, start: placed.start, end: placed.end + 0.15 });
      at = placed.end + GAPS.withinScene;
      return placed;
    });
    const narrationEnd = lines[lines.length - 1].end + (isLast ? GAPS.tailLast : GAPS.tail);
    const end = Math.max(cursor + scene.min, narrationEnd);
    scenes.push({ id: scene.id, start: cursor, end, lines });
    cursor = end;
  });
  return { scenes, clips, cues, total: cursor };
}

function mixAudio(timeline, total, output) {
  const args = ["-y"];
  timeline.clips.forEach((clip) => args.push("-i", clip.file));
  const delays = timeline.clips.map((clip, i) => {
    const ms = Math.round(clip.start * 1000);
    return `[${i}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${ms}:all=1[a${i}]`;
  });
  const inputs = timeline.clips.map((_, i) => `[a${i}]`).join("");
  const graph = `${delays.join(";")};${inputs}amix=inputs=${timeline.clips.length}:normalize=0,apad,atrim=0:${total.toFixed(3)}[out]`;
  args.push("-filter_complex", graph, "-map", "[out]", output);
  run("ffmpeg", args);
}

function toVtt(cues) {
  const stamp = (seconds) => {
    const ms = Math.round(seconds * 1000);
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
  };
  const body = cues.map((cue, i) => `${i + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`);
  return `WEBVTT\n\n${body.join("\n")}`;
}

async function renderVideo(page, output) {
  const frames = Math.round(page.total * FPS);
  const stillTimes = new Set(stillFrames(page.timeline));
  await withPage(page, async (capture) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
      "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-tune", "animation", "-vf", "scale=in_range=full:out_range=tv,format=yuv420p", "-r", String(FPS), output
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let ffmpegError = "";
    ffmpeg.stderr.on("data", (chunk) => { ffmpegError += chunk; });
    const ffmpegDone = new Promise((resolve, reject) => {
      ffmpeg.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${ffmpegError.slice(-800)}`))));
    });

    try {
      for (let i = 0; i < frames; i++) {
        const buffer = await capture(i / FPS);
        if (stillTimes.has(i)) writeFileSync(path.join(buildDir, "stills", `frame-${String(i).padStart(5, "0")}.jpg`), buffer);
        if (!ffmpeg.stdin.write(buffer)) await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve));
        if (i % 300 === 0) console.log(`  frame ${i}/${frames}`);
      }
      ffmpeg.stdin.end();
    } catch (error) {
      ffmpeg.kill();
      ffmpegDone.catch(() => {});
      throw error;
    }
    await ffmpegDone;
  });
}

// The slow zoom changes every pixel on every frame, which makes GIFs far too large, so the GIF frames render without it.
async function renderGif(page, output, range) {
  const framesDir = path.join(buildDir, "gif-frames");
  mkdirSync(framesDir, { recursive: true });
  const count = Math.round((range.end - range.start) * GIF_FPS);
  await withPage(page, async (capture) => {
    for (let i = 0; i < count; i++) {
      const buffer = await capture(range.start + i / GIF_FPS, { zoom: false });
      writeFileSync(path.join(framesDir, `${String(i).padStart(4, "0")}.jpg`), buffer);
    }
  });
  const attempts = [{ colors: 128 }, { colors: 96 }, { colors: 64 }, { colors: 48 }];
  for (const attempt of attempts) {
    const filters = "scale=960:-1:flags=lanczos";
    const palette = path.join(buildDir, "palette.png");
    const input = ["-framerate", String(GIF_FPS), "-i", path.join(framesDir, "%04d.jpg")];
    run("ffmpeg", ["-y", ...input, "-vf", `${filters},palettegen=max_colors=${attempt.colors}:stats_mode=diff`, palette]);
    run("ffmpeg", ["-y", ...input, "-i", palette, "-lavfi", `${filters}[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle`, "-loop", "0", output]);
    if (statSync(output).size <= GIF_LIMIT_BYTES) return { fps: GIF_FPS, colors: attempt.colors };
  }
  throw new Error("Could not fit demo.gif under 2 MB");
}

async function withPage({ timeline, captured, total }, work) {
  if (!existsSync(chromePath)) throw new Error(`Chrome not found at ${chromePath}`);
  const profile = mkdtempSync(path.join(tmpdir(), "agentpack-video-chrome-"));
  const chrome = spawn(chromePath, [
    "--headless=new", "--remote-debugging-port=0", "--window-size=1920,1080", "--hide-scrollbars",
    "--force-device-scale-factor=1", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });

  try {
    const port = await readDevtoolsPort(chrome);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((entry) => entry.type === "page");
    const cdp = await connect(target.webSocketDebuggerUrl);

    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.enable");
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: pathToFileURL(path.join(here, "scenes.html")).href });
    await loaded;

    const data = { scenes: timeline.scenes, cues: timeline.cues, captured, total };
    await evaluate(cdp, `window.setup(${JSON.stringify(data)})`);

    await work(async (t, options = {}) => {
      await evaluate(cdp, `window.render(${t.toFixed(4)}, ${JSON.stringify(options)})`);
      const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
      return Buffer.from(shot.data, "base64");
    });
    cdp.close();
  } finally {
    if (chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill();
      await exited;
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function stillFrames(timeline) {
  const frames = [];
  for (const scene of timeline.scenes) {
    const span = scene.end - scene.start;
    for (const fraction of [0.15, 0.4, 0.65, 0.92]) frames.push(Math.round((scene.start + span * fraction) * FPS));
  }
  return frames;
}

function evaluate(cdp, expression) {
  return cdp.send("Runtime.evaluate", { expression, awaitPromise: true }).then((result) => {
    if (result.exceptionDetails) throw new Error(`Page error: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    return result;
  });
}

function readDevtoolsPort(chrome) {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not report a DevTools port")), 20000);
    chrome.stderr.on("data", (chunk) => {
      text += chunk;
      const match = text.match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.once("exit", () => reject(new Error("Chrome exited early")));
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 1;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      } else if (listeners.has(message.method)) {
        listeners.get(message.method).forEach((resolveListener) => resolveListener(message.params));
        listeners.delete(message.method);
      }
    });
    socket.addEventListener("error", reject);
    socket.addEventListener("open", () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        return new Promise((resolveSend, rejectSend) => {
          pending.set(id, { resolve: resolveSend, reject: rejectSend });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      once(method) {
        return new Promise((resolveOnce) => {
          listeners.set(method, [...(listeners.get(method) || []), resolveOnce]);
        });
      },
      close: () => socket.close()
    }));
  });
}

function summarize({ voice, mp4, vtt, gif, gifSettings, timeline }) {
  const size = (file) => `${(statSync(file).size / 1024 / 1024).toFixed(2)} MB`;
  console.log("\nDone");
  console.log(`Voice: ${voice}`);
  console.log(`Duration: ${duration(mp4).toFixed(2)} s; video stream ${streamDuration(mp4, "v:0").toFixed(2)} s, audio stream ${streamDuration(mp4, "a:0").toFixed(2)} s`);
  console.log(`${path.relative(repoRoot, mp4)}: ${size(mp4)}`);
  console.log(`${path.relative(repoRoot, vtt)}: ${timeline.cues.length} cues`);
  console.log(`${path.relative(repoRoot, gif)}: ${size(gif)} (${gifSettings.fps} fps, ${gifSettings.colors} colors)`);
  for (const scene of timeline.scenes) console.log(`  ${scene.id}: ${scene.start.toFixed(1)}-${scene.end.toFixed(1)} s`);
  console.log(`Stills: ${path.relative(repoRoot, path.join(buildDir, "stills"))}`);
  console.log(readdirSync(path.join(buildDir, "stills")).length + " stills saved");
}

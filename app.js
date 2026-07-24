document.addEventListener("DOMContentLoaded", () => {
  // DOM Elements
  const statusBadge = document.getElementById("ffmpegStatus");
  const statusText = document.getElementById("statusText");

  const dropzone = document.getElementById("dropzone");
  const videoInput = document.getElementById("videoInput");
  const uploadPrompt = document.getElementById("uploadPrompt");
  const filePreview = document.getElementById("filePreview");
  const fileName = document.getElementById("fileName");
  const fileSize = document.getElementById("fileSize");
  const btnRemoveFile = document.getElementById("btnRemoveFile");

  const processForm = document.getElementById("processForm");
  const thresholdDb = document.getElementById("thresholdDb");
  const thresholdDbVal = document.getElementById("thresholdDbVal");
  const padding = document.getElementById("padding");
  const paddingVal = document.getElementById("paddingVal");
  const minSilenceMs = document.getElementById("minSilenceMs");
  const minSilenceMsVal = document.getElementById("minSilenceMsVal");
  const btnSubmit = document.getElementById("btnSubmit");

  const emptyState = document.getElementById("emptyState");
  const progressContainer = document.getElementById("progressContainer");
  const stageTitle = document.getElementById("stageTitle");
  const progressPercent = document.getElementById("progressPercent");
  const progressBarFill = document.getElementById("progressBarFill");
  const statusMsg = document.getElementById("statusMsg");

  const resultsContainer = document.getElementById("resultsContainer");
  const metricOriginal = document.getElementById("metricOriginal");
  const metricFinal = document.getElementById("metricFinal");
  const metricSaved = document.getElementById("metricSaved");
  const outputVideoPlayer = document.getElementById("outputVideoPlayer");
  const btnDownload = document.getElementById("btnDownload");

  let selectedFile = null;
  let ffmpegInstance = null;

  // 1. Initialize FFmpeg.wasm
  function initFFmpeg() {
    if (typeof FFmpeg === "undefined") {
      statusText.textContent = "Erro ao carregar FFmpeg.wasm";
      statusBadge.querySelector(".status-dot").style.backgroundColor = "#ef4444";
      return null;
    }
    const { createFFmpeg } = FFmpeg;
    const instance = createFFmpeg({
      log: true,
      corePath: "https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js",
    });
    statusText.textContent = "FFmpeg.wasm Suportado";
    statusBadge.querySelector(".status-dot").style.backgroundColor = "#06b6d4";
    return instance;
  }

  ffmpegInstance = initFFmpeg();

  // 2. Interactive Slider Label Updates
  thresholdDb.addEventListener("input", (e) => {
    thresholdDbVal.textContent = `${e.target.value} dB`;
  });

  padding.addEventListener("input", (e) => {
    paddingVal.textContent = `${e.target.value}s`;
  });

  minSilenceMs.addEventListener("input", (e) => {
    minSilenceMsVal.textContent = `${e.target.value} ms`;
  });

  // 3. File Selection
  function setFile(file) {
    if (!file || !file.type.startsWith("video/")) {
      alert("Por favor, selecione um arquivo de vídeo válido.");
      return;
    }
    selectedFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = formatBytes(file.size);

    uploadPrompt.classList.add("hidden");
    filePreview.classList.remove("hidden");
    btnSubmit.disabled = false;
  }

  function resetFile() {
    selectedFile = null;
    videoInput.value = "";
    uploadPrompt.classList.remove("hidden");
    filePreview.classList.add("hidden");
    btnSubmit.disabled = true;
  }

  videoInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) setFile(e.target.files[0]);
  });

  btnRemoveFile.addEventListener("click", (e) => {
    e.stopPropagation();
    resetFile();
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer.files.length > 0) setFile(e.dataTransfer.files[0]);
  });

  // 4. Mathematical Logic for Speech Segments
  function getSpeechSegments(silences, totalDuration, padSec = 0.2) {
    if (totalDuration <= 0) return [];

    const clamped = silences
      .map(([s, e]) => [
        Math.max(0, Math.min(totalDuration, s)),
        Math.max(0, Math.min(totalDuration, e)),
      ])
      .filter(([s, e]) => e > s)
      .sort((a, b) => a[0] - b[0]);

    const mergedSilences = [];
    for (const [s, e] of clamped) {
      if (mergedSilences.length === 0) {
        mergedSilences.push([s, e]);
      } else {
        const prev = mergedSilences[mergedSilences.length - 1];
        if (s <= prev[1]) {
          prev[1] = Math.max(prev[1], e);
        } else {
          mergedSilences.push([s, e]);
        }
      }
    }

    const rawSpeech = [];
    let currentTime = 0;
    for (const [sStart, sEnd] of mergedSilences) {
      if (sStart > currentTime) {
        rawSpeech.push([currentTime, sStart]);
      }
      currentTime = Math.max(currentTime, sEnd);
    }
    if (currentTime < totalDuration) {
      rawSpeech.push([currentTime, totalDuration]);
    }

    const paddedSpeech = [];
    for (const [s, e] of rawSpeech) {
      const pStart = Math.max(0, s - padSec);
      const pEnd = Math.min(totalDuration, e + padSec);
      if (pEnd > pStart) {
        paddedSpeech.push([pStart, pEnd]);
      }
    }

    // Merging speech blocks separated by gaps smaller than minGap (0.35s) to prevent hundreds of micro-cuts
    const minGap = 0.35;
    const finalSpeech = [];
    for (const [s, e] of paddedSpeech) {
      if (finalSpeech.length === 0) {
        finalSpeech.push([s, e]);
      } else {
        const prev = finalSpeech[finalSpeech.length - 1];
        if (s - prev[1] < minGap) {
          prev[1] = Math.max(prev[1], e);
        } else {
          finalSpeech.push([s, e]);
        }
      }
    }

    return finalSpeech.map(([s, e]) => [
      Number(s.toFixed(3)),
      Number(e.toFixed(3)),
    ]);
  }

  // 5. FFmpeg.wasm Execution Workflow
  processForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!selectedFile || !ffmpegInstance) return;

    const { fetchFile } = FFmpeg;

    // UI Updates
    emptyState.classList.add("hidden");
    resultsContainer.classList.add("hidden");
    progressContainer.classList.remove("hidden");
    btnSubmit.disabled = true;

    try {
      // Step 1: Load FFmpeg into browser memory
      updateProgressUI(5, 1, "Carregando Engine FFmpeg", "Inicializando ambiente WebAssembly...");
      if (!ffmpegInstance.isLoaded()) {
        await ffmpegInstance.load();
      }

      updateProgressUI(15, 1, "Lendo Vídeo", "Carregando arquivo na memória virtual do navegador...");
      ffmpegInstance.FS("writeFile", "input.mp4", await fetchFile(selectedFile));

      // Step 2: Extrair Áudio
      updateProgressUI(30, 2, "Extraindo Áudio", "Convertendo faixa sonora para WAV 16kHz mono...");
      await ffmpegInstance.run(
        "-y",
        "-i", "input.mp4",
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        "temp_audio.wav"
      );

      // Step 3: Detectar Silêncio
      updateProgressUI(45, 3, "Detectando Silêncio", "Analisando frequências sonoras...");
      const dbVal = parseFloat(thresholdDb.value);
      const minMs = parseFloat(minSilenceMs.value);
      const minSec = minMs / 1000.0;

      let ffmpegLogs = [];
      ffmpegInstance.setLogger(({ message }) => {
        if (message) ffmpegLogs.push(message);
      });

      await ffmpegInstance.run(
        "-hide_banner",
        "-i", "temp_audio.wav",
        "-af", `silencedetect=noise=${dbVal}dB:d=${minSec}`,
        "-f", "null",
        "-"
      );

      // Parse FFmpeg logs
      const fullLog = ffmpegLogs.join("\n");
      
      // Parse total duration
      let totalDuration = 0;
      const durationMatch = fullLog.match(/Duration:\s*(\d+):(\d+):([\d\.]+)/);
      if (durationMatch) {
        const h = parseFloat(durationMatch[1]);
        const m = parseFloat(durationMatch[2]);
        const s = parseFloat(durationMatch[3]);
        totalDuration = h * 3600 + m * 60 + s;
      }

      // Parse silence intervals
      const silenceStarts = [...fullLog.matchAll(/silence_start:\s*([\d\.]+)/g)].map(m => parseFloat(m[1]));
      const silenceEnds = [...fullLog.matchAll(/silence_end:\s*([\d\.]+)/g)].map(m => parseFloat(m[1]));

      const silences = [];
      for (let i = 0; i < Math.min(silenceStarts.length, silenceEnds.length); i++) {
        if (silenceEnds[i] > silenceStarts[i]) {
          silences.push([silenceStarts[i], silenceEnds[i]]);
        }
      }
      if (silenceStarts.length > silenceEnds.length && totalDuration > 0) {
        if (totalDuration > silenceStarts[silenceStarts.length - 1]) {
          silences.push([silenceStarts[silenceStarts.length - 1], totalDuration]);
        }
      }

      const padSec = parseFloat(padding.value);
      const speechSegments = getSpeechSegments(silences, totalDuration, padSec);

      if (speechSegments.length === 0) {
        alert("Nenhum trecho de fala foi identificado com os parâmetros selecionados.");
        resetToEmptyState();
        return;
      }

      // Step 4: Cortar Chunks & Concatenar
      updateProgressUI(65, 4, "Cortando Chunks", `Extraindo ${speechSegments.length} trechos de fala...`);
      const tempChunks = [];
      let listTxt = "";

      for (let i = 0; i < speechSegments.length; i++) {
        const [st, et] = speechSegments[i];
        const dur = Math.max(0, et - st);
        if (dur <= 0) continue;

        const chunkName = `chunk_${i + 1}.mp4`;
        tempChunks.push(chunkName);

        const chunkProgress = 65 + Math.floor(((i + 1) / speechSegments.length) * 20);
        updateProgressUI(chunkProgress, 4, "Cortando Chunks", `Extraindo trecho ${i + 1} de ${speechSegments.length}...`);

        await ffmpegInstance.run(
          "-y",
          "-ss", st.toFixed(3),
          "-i", "input.mp4",
          "-t", dur.toFixed(3),
          "-c", "copy",
          chunkName
        );

        // Pausa para dar tempo ao evento do navegador e garbage collector
        await new Promise((resolve) => setTimeout(resolve, 10));

        listTxt += `file '${chunkName}'\n`;
      }

      // Write list.txt to WASM Virtual FS
      const encoder = new TextEncoder();
      ffmpegInstance.FS("writeFile", "list.txt", encoder.encode(listTxt));

      updateProgressUI(88, 4, "Mesclando Vídeo Final", "Concatenando todos os chunks...");
      await ffmpegInstance.run(
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", "list.txt",
        "-c", "copy",
        "output.mp4"
      );

      // Step 5: Obter Arquivo Final em Memória
      updateProgressUI(100, 4, "Finalizando", "Gerando arquivo para download...");
      const outputData = ffmpegInstance.FS("readFile", "output.mp4");

      const finalDuration = speechSegments.reduce((acc, [st, et]) => acc + (et - st), 0);
      const savedDuration = Math.max(0, totalDuration - finalDuration);

      const blob = new Blob([outputData.buffer], { type: "video/mp4" });
      const videoUrl = URL.createObjectURL(blob);

      // Limpar arquivos no sistema virtual de arquivos
      try {
        ffmpegInstance.FS("unlink", "input.mp4");
        ffmpegInstance.FS("unlink", "temp_audio.wav");
        ffmpegInstance.FS("unlink", "list.txt");
        ffmpegInstance.FS("unlink", "output.mp4");
        for (const chunk of tempChunks) {
          ffmpegInstance.FS("unlink", chunk);
        }
      } catch (err) {
        console.warn("Erro ao limpar arquivos virtuais:", err);
      }

      showResults({
        originalDuration: totalDuration,
        finalDuration: finalDuration,
        savedDuration: savedDuration,
        silences: silences,
        speechSegments: speechSegments,
        videoUrl: videoUrl,
      });

    } catch (err) {
      console.error(err);
      alert(`Erro durante o processamento no navegador: ${err.message || err}`);
      resetToEmptyState();
    }
  });

  const timelineTrack = document.getElementById("timelineTrack");
  const rulerMid = document.getElementById("rulerMid");
  const rulerEnd = document.getElementById("rulerEnd");
  const cutsCountText = document.getElementById("cutsCountText");
  const btnToggleDetails = document.getElementById("btnToggleDetails");
  const toggleDetailsText = document.getElementById("toggleDetailsText");
  const cutsList = document.getElementById("cutsList");

  if (btnToggleDetails) {
    btnToggleDetails.addEventListener("click", () => {
      const isHidden = cutsList.classList.contains("hidden");
      if (isHidden) {
        cutsList.classList.remove("hidden");
        toggleDetailsText.textContent = "Ocultar lista de cortes";
      } else {
        cutsList.classList.add("hidden");
        toggleDetailsText.textContent = "Mostrar lista de cortes";
      }
    });
  }

  // UI Helper Functions
  function updateProgressUI(percent, stepNumber, stepName, message) {
    progressPercent.textContent = `${percent}%`;
    progressBarFill.style.width = `${percent}%`;
    stageTitle.textContent = stepName;
    statusMsg.textContent = message;

    for (let i = 1; i <= 4; i++) {
      const stepEl = document.getElementById(`step${i}`);
      if (!stepEl) continue;

      stepEl.classList.remove("active", "completed");
      if (i < stepNumber) {
        stepEl.classList.add("completed");
        stepEl.querySelector(".step-badge").textContent = "✓";
      } else if (i === stepNumber) {
        stepEl.classList.add("active");
        stepEl.querySelector(".step-badge").textContent = i;
      } else {
        stepEl.querySelector(".step-badge").textContent = i;
      }
    }
  }

  function showResults(res) {
    progressContainer.classList.add("hidden");
    resultsContainer.classList.remove("hidden");
    btnSubmit.disabled = false;

    metricOriginal.textContent = formatDuration(res.originalDuration);
    metricFinal.textContent = formatDuration(res.finalDuration);
    metricSaved.textContent = formatDuration(res.savedDuration);

    outputVideoPlayer.src = res.videoUrl;
    outputVideoPlayer.load();

    btnDownload.href = res.videoUrl;

    renderTimeline(res.originalDuration, res.silences || [], res.speechSegments || []);
  }

  function renderTimeline(totalDuration, silences, speechSegments) {
    if (!timelineTrack) return;
    timelineTrack.innerHTML = "";
    cutsList.innerHTML = "";

    if (!totalDuration || totalDuration <= 0) return;

    if (rulerMid) rulerMid.textContent = formatDuration(totalDuration / 2);
    if (rulerEnd) rulerEnd.textContent = formatDuration(totalDuration);

    const allSegments = [];
    (speechSegments || []).forEach(([start, end]) => {
      allSegments.push({ type: "speech", start, end });
    });
    (silences || []).forEach(([start, end]) => {
      allSegments.push({ type: "silence", start, end });
    });
    allSegments.sort((a, b) => a.start - b.start);

    allSegments.forEach((seg) => {
      const widthPct = Math.max(0.2, ((seg.end - seg.start) / totalDuration) * 100);
      const segEl = document.createElement("div");
      segEl.className = `timeline-segment ${seg.type}`;
      segEl.style.width = `${widthPct}%`;

      const typeLabel = seg.type === "speech" ? "Fala" : "Silêncio Cortado";
      const durSec = (seg.end - seg.start).toFixed(1);
      const timeStr = `${formatDuration(seg.start)} - ${formatDuration(seg.end)}`;
      segEl.setAttribute("data-tooltip", `${typeLabel}: ${timeStr} (${durSec}s)`);

      segEl.addEventListener("click", () => {
        if (outputVideoPlayer) {
          outputVideoPlayer.currentTime = seg.start;
          outputVideoPlayer.play();
        }
      });

      timelineTrack.appendChild(segEl);
    });

    const count = silences.length;
    if (cutsCountText) {
      cutsCountText.textContent = `${count} ${count === 1 ? "silêncio cortado" : "silêncios cortados"}`;
    }

    if (count === 0 && cutsList) {
      cutsList.innerHTML = `<div class="cut-item" style="color: var(--text-muted);">Nenhum intervalo de silêncio significativo foi detectado.</div>`;
      return;
    }

    if (cutsList) {
      silences.forEach(([st, et], idx) => {
        const dur = (et - st).toFixed(1);
        const cutItem = document.createElement("div");
        cutItem.className = "cut-item";

        cutItem.innerHTML = `
          <div class="cut-time-range">
            <span>Corte #${idx + 1}: ${formatDuration(st)} → ${formatDuration(et)}</span>
            <span class="cut-badge-dur">-${dur}s</span>
          </div>
          <button type="button" class="btn-seek-cut" title="Navegar no vídeo">▶ Ponto do corte</button>
        `;

        const btnSeek = cutItem.querySelector(".btn-seek-cut");
        btnSeek.addEventListener("click", () => {
          if (outputVideoPlayer) {
            outputVideoPlayer.currentTime = st;
            outputVideoPlayer.play();
          }
        });

        cutsList.appendChild(cutItem);
      });
    }
  }

  function resetToEmptyState() {
    progressContainer.classList.add("hidden");
    resultsContainer.classList.add("hidden");
    emptyState.classList.remove("hidden");
    btnSubmit.disabled = false;
  }

  function formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  function formatDuration(seconds) {
    const totalSec = Math.round(seconds);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
});

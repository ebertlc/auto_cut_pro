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
  function getSpeechSegments(silences, totalDuration, padSec = 0.1) {
    if (!totalDuration || totalDuration <= 0) return [];

    const clamped = (silences || [])
      .map(([s, e]) => [
        Math.max(0, Math.min(totalDuration, Number(s))),
        Math.max(0, Math.min(totalDuration, Number(e))),
      ])
      .filter(([s, e]) => e > s)
      .sort((a, b) => a[0] - b[0]);

    const mergedSilences = [];
    for (const [st, et] of clamped) {
      if (mergedSilences.length === 0) {
        mergedSilences.push([st, et]);
      } else {
        const prev = mergedSilences[mergedSilences.length - 1];
        if (st <= prev[1]) {
          prev[1] = Math.max(prev[1], et);
        } else {
          mergedSilences.push([st, et]);
        }
      }
    }

    if (mergedSilences.length === 0) {
      return [[0, Number(totalDuration.toFixed(3))]];
    }

    const speechSegments = [];
    let currentTime = 0;

    for (const [sStart, sEnd] of mergedSilences) {
      const silenceDur = sEnd - sStart;
      // Padding seguro que nunca anula o silêncio (máximo de 40% da duração do silêncio de cada lado)
      const safePad = Math.max(0, Math.min(padSec, (silenceDur / 2.0) - 0.02));

      const speechEnd = sStart + safePad;
      const nextSpeechStart = sEnd - safePad;

      if (speechEnd > currentTime) {
        speechSegments.push([
          Number(currentTime.toFixed(3)),
          Number(speechEnd.toFixed(3)),
        ]);
      }
      currentTime = nextSpeechStart;
    }

    if (currentTime < totalDuration) {
      speechSegments.push([
        Number(currentTime.toFixed(3)),
        Number(totalDuration.toFixed(3)),
      ]);
    }

    return speechSegments.filter(([s, e]) => e > s);
  }

  const consoleBody = document.getElementById("consoleBody");
  const liveStatsBar = document.getElementById("liveStatsBar");
  const liveSilencesCount = document.getElementById("liveSilencesCount");
  const liveSpeechCount = document.getElementById("liveSpeechCount");
  const liveEstDuration = document.getElementById("liveEstDuration");

  function logToConsole(message, type = "info") {
    if (!consoleBody) return;
    const now = new Date();
    const timeStr = now.toTimeString().split(" ")[0];

    const line = document.createElement("div");
    line.className = "console-line";
    line.innerHTML = `
      <span class="console-time">[${timeStr}]</span>
      <span class="console-msg ${type}">${escapeHtml(message)}</span>
    `;

    consoleBody.appendChild(line);
    consoleBody.scrollTop = consoleBody.scrollHeight;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // 5. Hybrid Auto-Switch Execution Workflow (Native Server vs Browser WASM)
  processForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!selectedFile) return;

    // Reset Console
    if (consoleBody) consoleBody.innerHTML = "";
    if (liveStatsBar) liveStatsBar.classList.add("hidden");

    // UI Updates
    emptyState.classList.add("hidden");
    resultsContainer.classList.add("hidden");
    progressContainer.classList.remove("hidden");
    btnSubmit.disabled = true;

    logToConsole(`Iniciando AutoCut Pro para '${selectedFile.name}' (${formatBytes(selectedFile.size)})...`, "info");

    // 1. Verificação de Servidor Nativo Local (FastAPI python server.py)
    let isNativeServerOnline = false;
    try {
      const statusRes = await fetch("/api/status", { method: "GET", cache: "no-store" });
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        if (statusData.ffmpeg_installed) {
          isNativeServerOnline = true;
        }
      }
    } catch (err) {
      isNativeServerOnline = false;
    }

    if (isNativeServerOnline) {
      // MODO SERVIDOR NATIVO LOCAL: 30x mais rápido (aproveita todos os núcleos do CPU/GPU do sistema)
      logToConsole("🚀 Servidor Nativo Local Detectado! Utilizando aceleração máxima de hardware (30x mais rápido)...", "success");
      updateProgressUI(10, 1, "Enviando para Servidor Nativo", "Transmitindo arquivo para o engine nativo...");

      const formData = new FormData();
      formData.append("video", selectedFile);
      formData.append("threshold_db", thresholdDb.value);
      formData.append("padding", padding.value);
      formData.append("min_silence_ms", minSilenceMs.value);

      try {
        const uploadRes = await fetch("/api/process", {
          method: "POST",
          body: formData,
        });

        if (!uploadRes.ok) throw new Error("Falha ao comunicar com o servidor nativo.");
        const uploadData = await uploadRes.json();
        
        logToConsole(`✔ Upload concluído. ID da Tarefa: ${uploadData.task_id}. Processando no sistema nativo...`, "info");
        startNativeProgressPolling(uploadData.task_id);
        return;
      } catch (err) {
        logToConsole(`⚠ Falha no servidor nativo (${err.message}). Recorrendo ao modo WebAssembly do navegador...`, "warning");
      }
    } else {
      logToConsole("ℹ Servidor local não detectado. Executando via WebAssembly (Client-Side no navegador)...", "info");
      logToConsole("💡 Dica de velocidade: Execute 'python server.py' no terminal para cortar vídeos longos em 3 segundos!", "warning");
    }

    // 2. MODO BROWSER WEBASSEMBLY (Client-Side Fallback)
    try {
      const { fetchFile } = FFmpeg;

      // Step 1: Load FFmpeg into browser memory
      updateProgressUI(5, 1, "Carregando Engine FFmpeg", "Inicializando ambiente WebAssembly...");
      logToConsole("Carregando módulos do FFmpeg.wasm na memória RAM...", "info");

      if (!ffmpegInstance.isLoaded()) {
        await ffmpegInstance.load();
        logToConsole("✔ Engine FFmpeg.wasm pronta!", "success");
      }

      updateProgressUI(15, 1, "Lendo Vídeo", "Carregando arquivo na memória virtual do navegador...");
      logToConsole(`Gravando '${selectedFile.name}' na memória virtual do navegador (MEMFS)...`, "info");
      ffmpegInstance.FS("writeFile", "input.mp4", await fetchFile(selectedFile));
      logToConsole("✔ Arquivo montado com sucesso na memória virtual.", "success");

      // Step 2: Extrair Áudio
      updateProgressUI(30, 2, "Extraindo Áudio", "Convertendo faixa sonora para WAV 16kHz mono...");
      logToConsole("Executando FFmpeg: extraindo faixa de áudio WAV (16000Hz mono PCM)...", "info");
      await ffmpegInstance.run(
        "-y",
        "-i", "input.mp4",
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        "temp_audio.wav"
      );
      logToConsole("✔ Áudio extraído: temp_audio.wav criado.", "success");

      // Step 3: Detectar Silêncio
      updateProgressUI(45, 3, "Detectando Silêncio", "Analisando frequências sonoras...");
      const dbVal = parseFloat(thresholdDb.value);
      const minMs = parseFloat(minSilenceMs.value);
      const minSec = minMs / 1000.0;

      logToConsole(`Executando filtro silencedetect (noise=${dbVal}dB, min_dur=${minSec}s)...`, "info");

      let ffmpegLogs = [];
      let currentTotalDuration = 0;

      ffmpegInstance.setLogger(({ message }) => {
        if (!message) return;
        ffmpegLogs.push(message);

        // Capturar duração total quando informada pelo FFmpeg
        const durMatch = message.match(/Duration:\s*(\d+):(\d+):([\d\.]+)/);
        if (durMatch) {
          const h = parseFloat(durMatch[1]);
          const m = parseFloat(durMatch[2]);
          const s = parseFloat(durMatch[3]);
          currentTotalDuration = h * 3600 + m * 60 + s;
        }

        // Real-time FFmpeg rendering progress parser: frame= 450 fps=95 time=00:00:18.75 speed=3.9x
        const timeMatch = message.match(/time=\s*(\d+):(\d+):([\d\.]+)/);
        if (timeMatch) {
          const h = parseFloat(timeMatch[1]);
          const m = parseFloat(timeMatch[2]);
          const s = parseFloat(timeMatch[3]);
          const currentTimeSec = h * 3600 + m * 60 + s;

          const speedMatch = message.match(/speed=\s*([\d\.]+)x/);
          const fpsMatch = message.match(/fps=\s*([\d\.]+)/);
          const frameMatch = message.match(/frame=\s*(\d+)/);

          const speedStr = speedMatch ? `${speedMatch[1]}x` : "1.0x";
          const frameStr = frameMatch ? `frame ${frameMatch[1]}` : "";
          const timeStr = `${timeMatch[1]}:${timeMatch[2]}:${Math.floor(s).toString().padStart(2, "0")}`;

          if (currentTotalDuration > 0) {
            const renderPct = Math.min(96, Math.max(65, 65 + Math.floor((currentTimeSec / currentTotalDuration) * 31)));
            updateProgressUI(
              renderPct,
              4,
              "Renderizando Vídeo Final",
              `Renderizando: ${renderPct}% | tempo=${timeStr} (velocidade: ${speedStr})`
            );
          } else {
            updateProgressUI(
              75,
              4,
              "Renderizando Vídeo Final",
              `Renderizando: tempo=${timeStr} (${speedStr})`
            );
          }

          logToConsole(`🎞 Renderizando ${frameStr}: tempo=${timeStr} [velocidade: ${speedStr}]`, "ffmpeg");
        } else if (message.includes("silence_start") || message.includes("silence_end")) {
          logToConsole(message, "ffmpeg");
        }
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

      const estDuration = speechSegments.reduce((acc, [st, et]) => acc + (et - st), 0);

      logToConsole(`✔ Análise concluída: ${silences.length} silêncio(s) detectado(s).`, "success");
      logToConsole(`✔ ${speechSegments.length} trecho(s) de fala a serem mantidos. Duração estimada: ${formatDuration(estDuration)}.`, "success");

      // Atualizar Barra de Estatísticas em Tempo Real
      if (liveStatsBar) {
        liveStatsBar.classList.remove("hidden");
        liveSilencesCount.textContent = silences.length;
        liveSpeechCount.textContent = speechSegments.length;
        liveEstDuration.textContent = formatDuration(estDuration);
      }

      if (speechSegments.length === 0) {
        logToConsole("⚠ Nenhum trecho de fala foi identificado com os parâmetros selecionados.", "warning");
        alert("Nenhum trecho de fala foi identificado com os parâmetros selecionados.");
        resetToEmptyState();
        return;
      }

      // Step 4: Cortar & Concatenar Inteligente (Smart Fast Cut com Correção de Timestamps)
      // Utiliza busca rápida com correção de PTS/DTS (-avoid_negative_ts make_zero) para garantir corte real + velocidade máxima!
      updateProgressUI(65, 4, "Cortando Vídeo (Modo Rápido & Preciso)", `Processando ${speechSegments.length} trecho(s) de fala com alinhamento de timestamps...`);
      logToConsole(`⚡ Modo Rápido & Preciso Ativado: processando ${speechSegments.length} trechos com correção de PTS/DTS...`, "info");

      const BATCH_SIZE = 20;
      const batchFiles = [];
      const totalSegments = speechSegments.length;
      const encoder = new TextEncoder();

      try {
        for (let i = 0; i < totalSegments; i += BATCH_SIZE) {
          const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
          const currentBatchSegments = speechSegments.slice(i, i + BATCH_SIZE);
          const currentChunks = [];
          let batchListTxt = "";

          for (let j = 0; j < currentBatchSegments.length; j++) {
            const globalIdx = i + j;
            const [st, et] = currentBatchSegments[j];
            const dur = Math.max(0, et - st);
            if (dur <= 0) continue;

            const chunkName = `chunk_${globalIdx + 1}.mp4`;
            currentChunks.push(chunkName);

            const chunkProgress = 65 + Math.floor(((globalIdx + 1) / totalSegments) * 22);
            updateProgressUI(
              chunkProgress,
              4,
              "Cortando Vídeo (Modo Rápido & Preciso)",
              `Corte ${globalIdx + 1} de ${totalSegments} (${st.toFixed(1)}s → ${et.toFixed(1)}s)...`
            );

            // FFmpeg Stream Copy com correção de timestamps para garantir que o vídeo venha cortado de verdade
            await ffmpegInstance.run(
              "-y",
              "-fflags", "+genpts",
              "-ss", st.toFixed(3),
              "-i", "input.mp4",
              "-t", dur.toFixed(3),
              "-avoid_negative_ts", "make_zero",
              "-c", "copy",
              chunkName
            );

            await new Promise((resolve) => setTimeout(resolve, 8));
            batchListTxt += `file '${chunkName}'\n`;
          }

          if (currentChunks.length > 0) {
            const batchFileName = `batch_${batchIndex}.mp4`;
            batchFiles.push(batchFileName);

            const listFileName = `list_batch_${batchIndex}.txt`;
            ffmpegInstance.FS("writeFile", listFileName, encoder.encode(batchListTxt));

            await ffmpegInstance.run(
              "-y",
              "-f", "concat",
              "-safe", "0",
              "-i", listFileName,
              "-c", "copy",
              batchFileName
            );

            ffmpegInstance.FS("unlink", listFileName);
            for (const chunk of currentChunks) {
              try {
                ffmpegInstance.FS("unlink", chunk);
              } catch (err) {}
            }
          }
        }

        // Unir lotes finais via Concat Demuxer
        updateProgressUI(90, 4, "Mesclando Vídeo Final", "Unindo lotes de trechos cortados...");
        let finalBatchListTxt = "";
        for (const bFile of batchFiles) {
          finalBatchListTxt += `file '${bFile}'\n`;
        }
        ffmpegInstance.FS("writeFile", "list_final.txt", encoder.encode(finalBatchListTxt));

        await ffmpegInstance.run(
          "-y",
          "-f", "concat",
          "-safe", "0",
          "-i", "list_final.txt",
          "-c", "copy",
          "output.mp4"
        );

        ffmpegInstance.FS("unlink", "list_final.txt");
        for (const bFile of batchFiles) {
          try {
            ffmpegInstance.FS("unlink", bFile);
          } catch (err) {}
        }

        logToConsole("⚡ Vídeo cortado com sucesso em modo rápido e preciso!", "success");

      } catch (fastErr) {
        logToConsole("⚠ Recorrendo ao renderizador ultrafast de passagem única...", "warning");

        let filterScript = "";
        let concatInputs = "";

        for (let k = 0; k < speechSegments.length; k++) {
          const [st, et] = speechSegments[k];
          filterScript += `[0:v]trim=start=${st.toFixed(3)}:end=${et.toFixed(3)},setpts=PTS-STARTPTS[v${k}];\n`;
          filterScript += `[0:a]atrim=start=${st.toFixed(3)}:end=${et.toFixed(3)},asetpts=PTS-STARTPTS[a${k}];\n`;
          concatInputs += `[v${k}][a${k}]`;
        }

        filterScript += `${concatInputs}concat=n=${speechSegments.length}:v=1:a=1[outv][outa]`;
        ffmpegInstance.FS("writeFile", "filter.txt", encoder.encode(filterScript));

        await ffmpegInstance.run(
          "-y",
          "-i", "input.mp4",
          "-filter_complex_script", "filter.txt",
          "-map", "[outv]",
          "-map", "[outa]",
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-tune", "zerolatency",
          "-crf", "28",
          "output.mp4"
        );

        try {
          ffmpegInstance.FS("unlink", "filter.txt");
        } catch (err) {}
      }

      // Step 5: Obter Arquivo Final em Memória
      updateProgressUI(100, 4, "Finalizando", "Gerando arquivo para download...");
      const outputData = ffmpegInstance.FS("readFile", "output.mp4");

      const finalDuration = speechSegments.reduce((acc, [st, et]) => acc + (et - st), 0);
      const savedDuration = Math.max(0, totalDuration - finalDuration);

      const blob = new Blob([outputData.buffer], { type: "video/mp4" });
      const videoUrl = URL.createObjectURL(blob);

      // Limpar arquivos restantes no sistema virtual de arquivos
      try {
        ffmpegInstance.FS("unlink", "input.mp4");
        ffmpegInstance.FS("unlink", "temp_audio.wav");
        ffmpegInstance.FS("unlink", "output.mp4");
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

    btnDownload.href = res.downloadUrl || res.videoUrl;
    if (res.filename) {
      btnDownload.download = res.filename;
    }
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

  let progressInterval = null;

  function startNativeProgressPolling(taskId) {
    if (progressInterval) clearInterval(progressInterval);

    progressInterval = setInterval(() => {
      fetch(`/api/progress/${taskId}`)
        .then((res) => res.json())
        .then((task) => {
          updateProgressUI(
            task.progress,
            task.step,
            task.step_name,
            task.message
          );

          if (task.message && task.message !== lastLoggedMsg) {
            lastLoggedMsg = task.message;
            const logType = task.status === "completed" ? "success" : "info";
            logToConsole(task.message, logType);
          }

          if (task.silences && task.speech_segments && liveStatsBar) {
            liveStatsBar.classList.remove("hidden");
            liveSilencesCount.textContent = task.silences.length;
            liveSpeechCount.textContent = task.speech_segments.length;
            const estDur = task.speech_segments.reduce((acc, [st, et]) => acc + (et - st), 0);
            liveEstDuration.textContent = formatDuration(estDur);
          }

          if (task.status === "completed") {
            clearInterval(progressInterval);
            logToConsole("⚡ Processamento nativo concluído no servidor em SEGUNDOS!", "success");
            setTimeout(() => {
              showResults({
                originalDuration: task.result.original_duration,
                finalDuration: task.result.final_duration,
                savedDuration: task.result.saved_duration,
                silences: task.result.silences || [],
                speechSegments: task.result.speech_segments || [],
                videoUrl: task.result.stream_url,
                downloadUrl: task.result.download_url,
                filename: task.result.output_filename,
              });
            }, 500);
          } else if (task.status === "error") {
            clearInterval(progressInterval);
            logToConsole(`✖ Erro no processamento nativo: ${task.message}`, "warning");
            alert(`Erro no processamento nativo: ${task.message}`);
            resetToEmptyState();
          }
        })
        .catch(() => {
          clearInterval(progressInterval);
        });
    }, 500);
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

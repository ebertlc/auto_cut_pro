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
  let progressInterval = null;

  // 1. Check FFmpeg system status
  fetch("/api/status")
    .then(res => res.json())
    .then(data => {
      if (data.ffmpeg_installed) {
        statusText.textContent = "FFmpeg Conectado";
        statusBadge.querySelector(".status-dot").style.backgroundColor = "#10b981";
      } else {
        statusText.textContent = "FFmpeg Não Detectado";
        statusBadge.querySelector(".status-dot").style.backgroundColor = "#ef4444";
      }
    })
    .catch(() => {
      statusText.textContent = "Servidor Desconectado";
    });

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

  // 3. File Selection & Drag-and-Drop
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
    if (e.target.files.length > 0) {
      setFile(e.target.files[0]);
    }
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
    if (e.dataTransfer.files.length > 0) {
      setFile(e.dataTransfer.files[0]);
    }
  });

  // 4. Form Submission & Processing
  processForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!selectedFile) return;

    const formData = new FormData();
    formData.append("video", selectedFile);
    formData.append("threshold_db", thresholdDb.value);
    formData.append("padding", padding.value);
    formData.append("min_silence_ms", minSilenceMs.value);

    // Switch UI to Progress State
    emptyState.classList.add("hidden");
    resultsContainer.classList.add("hidden");
    progressContainer.classList.remove("hidden");
    btnSubmit.disabled = true;

    updateProgressUI(0, 1, "Iniciando", "Enviando arquivo de vídeo para o servidor...");

    fetch("/api/process", {
      method: "POST",
      body: formData,
    })
      .then((res) => {
        if (!res.ok) throw new Error("Falha no upload do vídeo.");
        return res.json();
      })
      .then((data) => {
        startProgressPolling(data.task_id);
      })
      .catch((err) => {
        alert(`Erro: ${err.message}`);
        resetToEmptyState();
      });
  });

  const consoleBody = document.getElementById("consoleBody");
  const liveStatsBar = document.getElementById("liveStatsBar");
  const liveSilencesCount = document.getElementById("liveSilencesCount");
  const liveSpeechCount = document.getElementById("liveSpeechCount");
  const liveEstDuration = document.getElementById("liveEstDuration");

  let lastLoggedMsg = "";

  function logToConsole(message, type = "info") {
    if (!consoleBody || !message) return;
    if (message === lastLoggedMsg) return;
    lastLoggedMsg = message;

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

  const timelineTrack = document.getElementById("timelineTrack");
  const timelineRuler = document.getElementById("timelineRuler");
  const rulerMid = document.getElementById("rulerMid");
  const rulerEnd = document.getElementById("rulerEnd");
  const cutsCountText = document.getElementById("cutsCountText");
  const btnToggleDetails = document.getElementById("btnToggleDetails");
  const toggleDetailsText = document.getElementById("toggleDetailsText");
  const cutsList = document.getElementById("cutsList");

  // Toggle Cuts List Accordion
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

  // 5. Progress Polling
  function startProgressPolling(taskId) {
    if (progressInterval) clearInterval(progressInterval);
    if (consoleBody) consoleBody.innerHTML = "";
    if (liveStatsBar) liveStatsBar.classList.add("hidden");

    logToConsole("Tarefa enviada ao servidor. Aguardando início do processamento...", "info");

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

          if (task.message) {
            const logType = task.status === "completed" ? "success" : "info";
            logToConsole(task.message, logType);
          }

          // Atualizar barra de estatísticas assim que silêncios/segmentos estiverem prontos
          if (task.silences && task.speech_segments && liveStatsBar) {
            liveStatsBar.classList.remove("hidden");
            liveSilencesCount.textContent = task.silences.length;
            liveSpeechCount.textContent = task.speech_segments.length;

            const estDur = task.speech_segments.reduce((acc, [st, et]) => acc + (et - st), 0);
            liveEstDuration.textContent = formatDuration(estDur);
          }

          if (task.status === "completed") {
            clearInterval(progressInterval);
            logToConsole("✔ Processamento finalizado no servidor com sucesso!", "success");
            setTimeout(() => showResults(task.result), 600);
          } else if (task.status === "error") {
            clearInterval(progressInterval);
            logToConsole(`✖ Erro no servidor: ${task.message}`, "warning");
            alert(`Erro no processamento: ${task.message}`);
            resetToEmptyState();
          }
        })
        .catch(() => {
          clearInterval(progressInterval);
        });
    }, 600);
  }

  function updateProgressUI(percent, stepNumber, stepName, message) {
    progressPercent.textContent = `${percent}%`;
    progressBarFill.style.width = `${percent}%`;
    stageTitle.textContent = stepName;
    statusMsg.textContent = message;

    // Update Steps List Indicators
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

  // 6. Present Final Results & Timeline
  function showResults(result) {
    progressContainer.classList.add("hidden");
    resultsContainer.classList.remove("hidden");
    btnSubmit.disabled = false;

    metricOriginal.textContent = formatDuration(result.original_duration);
    metricFinal.textContent = formatDuration(result.final_duration);
    metricSaved.textContent = formatDuration(result.saved_duration);

    outputVideoPlayer.src = result.stream_url;
    outputVideoPlayer.load();

    btnDownload.href = result.download_url;
    btnDownload.download = result.output_filename;

    // Render Timeline of Cuts
    renderTimeline(result.original_duration, result.silences || [], result.speech_segments || []);
  }

  function renderTimeline(totalDuration, silences, speechSegments) {
    if (!timelineTrack) return;
    timelineTrack.innerHTML = "";
    cutsList.innerHTML = "";

    if (!totalDuration || totalDuration <= 0) return;

    // 1. Setup Ruler Timestamps
    rulerMid.textContent = formatDuration(totalDuration / 2);
    rulerEnd.textContent = formatDuration(totalDuration);

    // 2. Build Timeline Segments (Combined Speech + Silences)
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

    // 3. Build Detailed Cuts List Accordion
    const count = silences.length;
    cutsCountText.textContent = `${count} ${count === 1 ? "silêncio cortado" : "silêncios cortados"}`;

    if (count === 0) {
      cutsList.innerHTML = `<div class="cut-item" style="color: var(--text-muted);">Nenhum intervalo de silêncio significativo foi detectado.</div>`;
      return;
    }

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

  function resetToEmptyState() {
    progressContainer.classList.add("hidden");
    resultsContainer.classList.add("hidden");
    emptyState.classList.remove("hidden");
    btnSubmit.disabled = false;
  }

  // Helpers
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

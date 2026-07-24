import os
import re
import sys
import shutil
import tempfile
import subprocess
import json
from pathlib import Path
from typing import List, Tuple, Dict, Any, Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
import importlib
import urllib.request
import urllib.error

# Tentar importar imageio_ffmpeg dinamicamente para obter o binário estático no ambiente Vercel Linux
IMAGEIO_FFMPEG_EXE = None
try:
    img_ff = importlib.import_module("imageio_ffmpeg")
    IMAGEIO_FFMPEG_EXE = img_ff.get_ffmpeg_exe()
except Exception:
    IMAGEIO_FFMPEG_EXE = None

def get_ffmpeg_binary() -> str:
    """Retorna o caminho do executável do FFmpeg (sistema ou estático)."""
    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg
    if IMAGEIO_FFMPEG_EXE and os.path.exists(IMAGEIO_FFMPEG_EXE):
        return IMAGEIO_FFMPEG_EXE
    raise RuntimeError("FFmpeg não encontrado no sistema nem via imageio-ffmpeg.")

app = FastAPI(title="AutoCut Pro Vercel Serverless API")

# Habilitar CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Diretório temporário /tmp para Serverless
TEMP_DIR = Path(tempfile.gettempdir()) / "autocut_serverless"
TEMP_DIR.mkdir(parents=True, exist_ok=True)

# Armazenamento em memória (fallback se Redis/KV não estiver configurado)
_memory_tasks_db: Dict[str, Dict[str, Any]] = {}

# Configuração de Upstash Redis / Vercel KV via REST API
KV_URL = os.getenv("UPSTASH_REDIS_REST_URL") or os.getenv("KV_REST_API_URL")
KV_TOKEN = os.getenv("UPSTASH_REDIS_REST_TOKEN") or os.getenv("KV_REST_API_TOKEN")

def save_task_state(task_id: str, data: Dict[str, Any]):
    """Salva estado da tarefa no KV/Redis (se disponível) ou em memória."""
    _memory_tasks_db[task_id] = data
    if KV_URL and KV_TOKEN:
        try:
            url = f"{KV_URL.rstrip('/')}/set/task:{task_id}"
            req = urllib.request.Request(
                url,
                data=json.dumps(data).encode("utf-8"),
                headers={"Authorization": f"Bearer {KV_TOKEN}", "Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=3.0) as response:
                pass
        except Exception:
            pass

def get_task_state(task_id: str) -> Optional[Dict[str, Any]]:
    """Recupera estado da tarefa do KV/Redis ou memória."""
    if KV_URL and KV_TOKEN:
        try:
            url = f"{KV_URL.rstrip('/')}/get/task:{task_id}"
            req = urllib.request.Request(
                url,
                headers={"Authorization": f"Bearer {KV_TOKEN}"},
                method="GET"
            )
            with urllib.request.urlopen(req, timeout=3.0) as res:
                if res.status == 200:
                    body = json.loads(res.read().decode("utf-8"))
                    if body.get("result"):
                        return json.loads(body["result"])
        except Exception:
            pass
    return _memory_tasks_db.get(task_id)


def detect_silence_intervals(
    audio_path: Path,
    threshold_db: float = -40.0,
    min_silence_ms: float = 500.0,
    ffmpeg_bin: str = "ffmpeg",
) -> Tuple[List[Tuple[float, float]], float]:
    """Executa o silencedetect e retorna silêncios + duração total."""
    min_dur_sec = max(0.1, min_silence_ms / 1000.0)
    cmd = [
        ffmpeg_bin, "-hide_banner",
        "-i", str(audio_path),
        "-af", f"silencedetect=noise={threshold_db}dB:d={min_dur_sec:.3f}",
        "-f", "null", "-"
    ]

    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    stderr = res.stderr or ""

    total_duration = 0.0
    dur_match = re.search(r"Duration:\s*(\d+):(\d+):([\d\.]+)", stderr)
    if dur_match:
        h, m, s = float(dur_match.group(1)), float(dur_match.group(2)), float(dur_match.group(3))
        total_duration = h * 3600 + m * 60 + s

    starts = [float(x) for x in re.findall(r"silence_start:\s*([\d\.]+)", stderr)]
    ends = [float(x) for x in re.findall(r"silence_end:\s*([\d\.]+)", stderr)]

    silences = []
    for i in range(min(len(starts), len(ends))):
        if ends[i] > starts[i]:
            silences.append((starts[i], ends[i]))

    if len(starts) > len(ends) and total_duration > 0:
        if total_duration > starts[-1]:
            silences.append((starts[-1], total_duration))

    return silences, total_duration


def get_speech_segments(
    silences: List[Tuple[float, float]],
    total_duration: float,
    padding: float = 0.1,
) -> List[Tuple[float, float]]:
    """Calcula segmentos de fala com padding seguro sem engolir silêncios."""
    if total_duration <= 0:
        return []

    clamped = []
    for s_start, s_end in silences:
        st = max(0.0, min(total_duration, float(s_start)))
        et = max(0.0, min(total_duration, float(s_end)))
        if et > st:
            clamped.append((st, et))

    clamped.sort(key=lambda x: x[0])

    merged_silences = []
    for st, et in clamped:
        if not merged_silences:
            merged_silences.append((st, et))
        else:
            pst, pet = merged_silences[-1]
            if st <= pet:
                merged_silences[-1] = (pst, max(pet, et))
            else:
                merged_silences.append((st, et))

    if not merged_silences:
        return [(0.0, round(total_duration, 4))]

    speech_segments = []
    current_time = 0.0

    for s_start, s_end in merged_silences:
        silence_dur = s_end - s_start
        safe_pad = max(0.0, min(padding, (silence_dur / 2.0) - 0.02))

        speech_end = s_start + safe_pad
        next_speech_start = s_end - safe_pad

        if speech_end > current_time:
            speech_segments.append((current_time, speech_end))
        current_time = next_speech_start

    if current_time < total_duration:
        speech_segments.append((current_time, total_duration))

    return [(round(s, 4), round(e, 4)) for s, e in speech_segments if e > s]


@app.get("/api/status")
def api_status():
    """Verifica se o backend e o FFmpeg estão operacionais."""
    try:
        ffmpeg_bin = get_ffmpeg_binary()
        return {
            "status": "online",
            "serverless": True,
            "ffmpeg_installed": True,
            "ffmpeg_path": ffmpeg_bin
        }
    except Exception as err:
        return {
            "status": "online",
            "serverless": True,
            "ffmpeg_installed": False,
            "error": str(err)
        }


@app.post("/api/process")
async def api_process(
    video: UploadFile = File(...),
    threshold_db: float = Form(-40.0),
    padding: float = Form(0.1),
    min_silence_ms: float = Form(500.0),
):
    """Ponto de entrada serverless para processamento de vídeo."""
    import uuid
    task_id = str(uuid.uuid4())[:8]

    try:
        ffmpeg_bin = get_ffmpeg_binary()
    except Exception as err:
        raise HTTPException(status_code=500, detail=str(err))

    # Salvar arquivo de vídeo enviado no diretório /tmp da função serverless
    video_ext = Path(video.filename).suffix or ".mp4"
    input_file_path = TEMP_DIR / f"{task_id}_input{video_ext}"
    output_file_path = TEMP_DIR / f"{task_id}_output.mp4"
    audio_file_path = TEMP_DIR / f"{task_id}_audio.wav"
    filter_script_path = TEMP_DIR / f"{task_id}_filter.txt"

    with open(input_file_path, "wb") as f:
        content = await video.read()
        f.write(content)

    initial_state = {
        "status": "processing",
        "progress": 15,
        "step": 1,
        "step_name": "Lendo Vídeo",
        "message": f"Arquivo '{video.filename}' carregado no ambiente Serverless."
    }
    save_task_state(task_id, initial_state)

    try:
        # Step 2: Extrair Áudio WAV
        save_task_state(task_id, {
            "status": "processing",
            "progress": 30,
            "step": 2,
            "step_name": "Extraindo Áudio",
            "message": "Extraindo faixa sonora de áudio..."
        })

        extract_cmd = [
            ffmpeg_bin, "-y", "-i", str(input_file_path),
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
            str(audio_file_path)
        ]
        subprocess.run(extract_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, check=True)

        # Step 3: Detectar Silêncios
        save_task_state(task_id, {
            "status": "processing",
            "progress": 50,
            "step": 3,
            "step_name": "Detectando Silêncio",
            "message": f"Analisando frequências sonoras ({threshold_db}dB, {min_silence_ms}ms)..."
        })

        silences, total_duration = detect_silence_intervals(
            audio_file_path, threshold_db, min_silence_ms, ffmpeg_bin
        )

        speech_segments = get_speech_segments(silences, total_duration, padding)
        final_duration = sum(et - st for st, et in speech_segments)
        saved_duration = max(0.0, total_duration - final_duration)

        # Step 4: Renderização Precisa de Passagem Única (trim + atrim filter_complex_script)
        save_task_state(task_id, {
            "status": "processing",
            "progress": 75,
            "step": 4,
            "step_name": "Renderizando Vídeo Final",
            "message": f"Renderizando {len(speech_segments)} trechos com remoção real de silêncio...",
            "silences": silences,
            "speech_segments": speech_segments
        })

        filter_lines = []
        concat_inputs = []
        for k, (st, et) in enumerate(speech_segments):
            dur = et - st
            if dur <= 0:
                continue
            filter_lines.append(f"[0:v]trim=start={st:.3f}:end={et:.3f},setpts=PTS-STARTPTS[v{k}];")
            filter_lines.append(f"[0:a]atrim=start={st:.3f}:end={et:.3f},asetpts=PTS-STARTPTS[a{k}];")
            concat_inputs.append(f"[v{k}][a{k}]")

        filter_lines.append(f"{''.join(concat_inputs)}concat=n={len(concat_inputs)}:v=1:a=1[outv][outa]")

        with open(filter_script_path, "w", encoding="utf-8") as f:
            f.write("\n".join(filter_lines))

        render_cmd = [
            ffmpeg_bin, "-y", "-i", str(input_file_path),
            "-filter_complex_script", str(filter_script_path),
            "-map", "[outv]", "-map", "[outa]",
            "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
            str(output_file_path)
        ]
        subprocess.run(render_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, check=True)

        # Sucesso: Montar resultado final
        output_filename = f"autocut_{task_id}.mp4"
        result_data = {
            "task_id": task_id,
            "original_duration": round(total_duration, 2),
            "final_duration": round(final_duration, 2),
            "saved_duration": round(saved_duration, 2),
            "silences": silences,
            "speech_segments": speech_segments,
            "output_filename": output_filename,
            "stream_url": f"/api/stream/{output_file_path.name}",
            "download_url": f"/api/download/{output_file_path.name}"
        }

        completed_state = {
            "status": "completed",
            "progress": 100,
            "step": 4,
            "step_name": "Concluído",
            "message": "Processamento serverless concluído com sucesso!",
            "result": result_data,
            "silences": silences,
            "speech_segments": speech_segments
        }
        save_task_state(task_id, completed_state)

        # Limpar arquivos temporários pesados
        for fpath in [audio_file_path, filter_script_path]:
            if fpath.exists():
                try:
                    fpath.unlink()
                except Exception:
                    pass

        return JSONResponse({"task_id": task_id, "status": "completed", "result": result_data})

    except Exception as err:
        err_state = {
            "status": "error",
            "progress": 0,
            "step": 0,
            "step_name": "Erro",
            "message": str(err)
        }
        save_task_state(task_id, err_state)
        raise HTTPException(status_code=500, detail=str(err))


@app.get("/api/progress/{task_id}")
def api_progress(task_id: str):
    """Consulta o progresso e resultado de uma tarefa."""
    state = get_task_state(task_id)
    if not state:
        raise HTTPException(status_code=404, detail="Tarefa não encontrada.")
    return JSONResponse(state)


@app.get("/api/stream/{filename}")
def api_stream(filename: str):
    """Entrega o vídeo processado para o player de mídia."""
    file_path = TEMP_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Arquivo não encontrado.")
    return FileResponse(path=str(file_path), media_type="video/mp4", filename=filename)


@app.get("/api/download/{filename}")
def api_download(filename: str):
    """Download direto do vídeo final cortado."""
    file_path = TEMP_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Arquivo não encontrado.")
    return FileResponse(path=str(file_path), media_type="application/octet-stream", filename=filename)

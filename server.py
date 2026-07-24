import os
import re
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Dict, List, Tuple

import uvicorn
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="AutoCut Pro API", version="1.0.0")

# Permitir CORS para requisições locais
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).parent.resolve()
UPLOAD_DIR = BASE_DIR / "temp_uploads"
OUTPUT_DIR = BASE_DIR / "outputs"
STATIC_DIR = BASE_DIR / "static"

UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)
STATIC_DIR.mkdir(exist_ok=True)

# Dicionário em memória para guardar o estado das tarefas
tasks_db: Dict[str, dict] = {}


def check_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def extract_audio(video_path: Path, output_audio_path: Path):
    command = [
        "ffmpeg",
        "-y",
        "-i", str(video_path),
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        str(output_audio_path),
    ]
    res = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        raise subprocess.CalledProcessError(res.returncode, command, stderr=res.stderr)


def detect_silence_and_duration(
    audio_path: Path,
    threshold_db: float,
    min_silence_ms: float,
) -> Tuple[List[Tuple[float, float]], float]:
    min_silence_sec = min_silence_ms / 1000.0
    command = [
        "ffmpeg",
        "-hide_banner",
        "-i", str(audio_path),
        "-af", f"silencedetect=noise={threshold_db}dB:d={min_silence_sec}",
        "-f", "null",
        "-",
    ]

    res = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    stderr = res.stderr

    duration_match = re.search(r"Duration:\s*(\d+):(\d+):([\d\.]+)", stderr)
    total_duration = 0.0
    if duration_match:
        h, m, s = float(duration_match.group(1)), float(duration_match.group(2)), float(duration_match.group(3))
        total_duration = h * 3600 + m * 60 + s

    silences: List[Tuple[float, float]] = []
    start_times = [float(x) for x in re.findall(r"silence_start:\s*([\d\.]+)", stderr)]
    end_times = [float(x) for x in re.findall(r"silence_end:\s*([\d\.]+)", stderr)]

    for i in range(min(len(start_times), len(end_times))):
        s_start, s_end = start_times[i], end_times[i]
        if s_end > s_start:
            silences.append((s_start, s_end))

    if len(start_times) > len(end_times) and total_duration > 0:
        if total_duration > start_times[-1]:
            silences.append((start_times[-1], total_duration))

    return silences, total_duration


def get_speech_segments(
    silences: List[Tuple[float, float]],
    total_duration: float,
    padding: float = 0.2,
) -> List[Tuple[float, float]]:
    if total_duration <= 0:
        return []

    clamped_silences = []
    for s_start, s_end in silences:
        st = max(0.0, min(total_duration, float(s_start)))
        et = max(0.0, min(total_duration, float(s_end)))
        if et > st:
            clamped_silences.append((st, et))

    clamped_silences.sort(key=lambda x: x[0])

    merged_silences = []
    for st, et in clamped_silences:
        if not merged_silences:
            merged_silences.append((st, et))
        else:
            pst, pet = merged_silences[-1]
            if st <= pet:
                merged_silences[-1] = (pst, max(pet, et))
            else:
                merged_silences.append((st, et))

    raw_speech = []
    current_time = 0.0

    for st, et in merged_silences:
        if st > current_time:
            raw_speech.append((current_time, st))
        current_time = max(current_time, et)

    if current_time < total_duration:
        raw_speech.append((current_time, total_duration))

    padded_speech = []
    for st, et in raw_speech:
        pst = max(0.0, st - padding)
        pet = min(total_duration, et + padding)
        if pet > pst:
            padded_speech.append((pst, pet))

    final_speech = []
    min_gap = 0.35  # Pausas de silêncio menores que 0.35s após padding são unificadas para evitar centenas de micro-cortes
    for st, et in padded_speech:
        if not final_speech:
            final_speech.append((st, et))
        else:
            pst, pet = final_speech[-1]
            if st - pet < min_gap:
                final_speech[-1] = (pst, max(pet, et))
            else:
                final_speech.append((st, et))

    return [(round(s, 4), round(e, 4)) for s, e in final_speech]


def process_video_task(
    task_id: str,
    input_file_path: Path,
    output_file_path: Path,
    threshold_db: float,
    padding: float,
    min_silence_ms: float,
):
    temp_audio = UPLOAD_DIR / f"{task_id}_temp.wav"
    temp_chunks: List[Path] = []
    list_file = UPLOAD_DIR / f"{task_id}_list.txt"

    try:
        # Etapa 1
        tasks_db[task_id]["step"] = 1
        tasks_db[task_id]["step_name"] = "Extraindo Áudio"
        tasks_db[task_id]["progress"] = 15
        tasks_db[task_id]["message"] = "Convertendo faixa de áudio para WAV 16kHz mono..."
        extract_audio(input_file_path, temp_audio)

        # Etapa 2
        tasks_db[task_id]["step"] = 2
        tasks_db[task_id]["step_name"] = "Detectando Silêncio"
        tasks_db[task_id]["progress"] = 40
        tasks_db[task_id]["message"] = f"Analisando frequências com limite de {threshold_db}dB..."
        silences, total_duration = detect_silence_and_duration(temp_audio, threshold_db, min_silence_ms)

        speech_segments = get_speech_segments(silences, total_duration, padding)
        final_duration = sum(end - start for start, end in speech_segments)

        # Salvar silêncios e segmentos de fala no banco em memória para a Timeline em tempo real
        tasks_db[task_id]["total_duration"] = total_duration
        tasks_db[task_id]["silences"] = silences
        tasks_db[task_id]["speech_segments"] = speech_segments

        # Se nenhum segmento de fala foi retornado (por ex: arquivo totalmente em silêncio ou fala contínua sem silêncios)
        if not speech_segments:
            if total_duration > 0:
                speech_segments = [(0.0, total_duration)]
                final_duration = total_duration
            else:
                raise ValueError("Não foi possível determinar a duração do áudio ou processar os segmentos.")

        total_chunks = len(speech_segments)

        # Etapa 3: Cortando Chunks com progresso incremental dinâmico
        tasks_db[task_id]["step"] = 3
        tasks_db[task_id]["step_name"] = "Cortando Chunks"
        tasks_db[task_id]["progress"] = 65
        tasks_db[task_id]["message"] = f"Extraindo {total_chunks} trecho(s) de fala sem re-codificação..."

        for i, (st, et) in enumerate(speech_segments, start=1):
            dur = max(0.0, et - st)
            if dur <= 0:
                continue

            # Atualização dinâmica de progresso entre 65% e 88%
            chunk_progress = 65 + int((i / total_chunks) * 23)
            tasks_db[task_id]["progress"] = min(88, chunk_progress)
            tasks_db[task_id]["message"] = f"Extraindo trecho {i} de {total_chunks} ({st:.1f}s → {et:.1f}s)..."

            chunk_path = UPLOAD_DIR / f"{task_id}_chunk_{i}.mp4"
            temp_chunks.append(chunk_path)

            cmd = [
                "ffmpeg", "-y", "-ss", str(st), "-i", str(input_file_path),
                "-t", str(dur), "-c", "copy", str(chunk_path)
            ]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            if res.returncode != 0:
                # Tentar corte alternativo se -c copy falhar devido a alinhamento de chave
                cmd_reencode = [
                    "ffmpeg", "-y", "-ss", str(st), "-i", str(input_file_path),
                    "-t", str(dur), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", str(chunk_path)
                ]
                subprocess.run(cmd_reencode, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)

        if not temp_chunks:
            raise ValueError("Nenhum trecho de vídeo válido pôde ser gerado.")

        # Criar list.txt
        with open(list_file, "w", encoding="utf-8") as f:
            for chunk in temp_chunks:
                f.write(f"file '{chunk.as_posix()}'\n")

        # Etapa 4
        tasks_db[task_id]["step"] = 4
        tasks_db[task_id]["step_name"] = "Mesclando Vídeo"
        tasks_db[task_id]["progress"] = 90
        tasks_db[task_id]["message"] = "Unindo trechos extraídos com o concat demuxer..."

        concat_cmd = [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", str(list_file), "-c", "copy", str(output_file_path)
        ]
        res_concat = subprocess.run(concat_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if res_concat.returncode != 0:
            # Fallback se re-encoding for necessário no concat
            concat_reencode = [
                "ffmpeg", "-y", "-f", "concat", "-safe", "0",
                "-i", str(list_file), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", str(output_file_path)
            ]
            subprocess.run(concat_reencode, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)

        saved_duration = max(0.0, total_duration - final_duration)

        tasks_db[task_id]["step"] = 5
        tasks_db[task_id]["step_name"] = "Concluído"
        tasks_db[task_id]["progress"] = 100
        tasks_db[task_id]["status"] = "completed"
        tasks_db[task_id]["message"] = "Processamento finalizado com sucesso!"
        tasks_db[task_id]["result"] = {
            "original_duration": total_duration,
            "final_duration": final_duration,
            "saved_duration": saved_duration,
            "segments_count": len(speech_segments),
            "silences": silences,
            "speech_segments": speech_segments,
            "output_filename": output_file_path.name,
            "download_url": f"/api/download/{output_file_path.name}",
            "stream_url": f"/api/stream/{output_file_path.name}",
        }

    except Exception as e:
        tasks_db[task_id]["status"] = "error"
        tasks_db[task_id]["message"] = f"Erro no processamento: {str(e)}"
    finally:
        # Limpar temporários
        if temp_audio.exists():
            temp_audio.unlink(missing_ok=True)
        if list_file.exists():
            list_file.unlink(missing_ok=True)
        for chunk in temp_chunks:
            if chunk.exists():
                chunk.unlink(missing_ok=True)


@app.get("/api/status")
def system_status():
    return {
        "ffmpeg_installed": check_ffmpeg(),
        "status": "online",
    }


@app.post("/api/process")
async def start_process(
    background_tasks: BackgroundTasks,
    video: UploadFile = File(...),
    threshold_db: float = Form(-40.0),
    padding: float = Form(0.2),
    min_silence_ms: float = Form(500.0),
):
    if not check_ffmpeg():
        raise HTTPException(status_code=500, detail="FFmpeg não está instalado no sistema host.")

    task_id = str(uuid.uuid4())
    ext = Path(video.filename).suffix or ".mp4"
    input_path = UPLOAD_DIR / f"{task_id}_input{ext}"
    output_path = OUTPUT_DIR / f"autocut_{task_id}{ext}"

    with open(input_path, "wb") as buffer:
        shutil.copyfileobj(video.file, buffer)

    tasks_db[task_id] = {
        "task_id": task_id,
        "status": "processing",
        "step": 0,
        "step_name": "Iniciando",
        "progress": 5,
        "message": "Upload recebido com sucesso. Agendando processamento...",
        "result": None,
    }

    background_tasks.add_task(
        process_video_task,
        task_id,
        input_path,
        output_path,
        threshold_db,
        padding,
        min_silence_ms,
    )

    return {"task_id": task_id, "status": "processing"}


@app.get("/api/progress/{task_id}")
def get_progress(task_id: str):
    if task_id not in tasks_db:
        raise HTTPException(status_code=404, detail="Tarefa não encontrada.")
    return tasks_db[task_id]


@app.get("/api/download/{filename}")
def download_output(filename: str):
    file_path = OUTPUT_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Arquivo não encontrado.")
    return FileResponse(path=file_path, filename=filename, media_type="video/mp4")


@app.get("/api/stream/{filename}")
def stream_output(filename: str):
    file_path = OUTPUT_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Arquivo não encontrado.")
    return FileResponse(path=file_path, media_type="video/mp4")


# Montar pasta estática para servir a interface web
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

if __name__ == "__main__":
    print("Iniciando servidor web AutoCut Pro em http://localhost:8000 ...")
    uvicorn.run(app, host="0.0.0.0", port=8000)

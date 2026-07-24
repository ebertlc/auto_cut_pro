#!/usr/bin/env python3
"""
AutoCut Pro - CLI para remoção automática de silêncio em vídeos via FFmpeg.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Tuple

# Tentar importar Rich para interface rica no terminal; se não estiver instalado, usa fallback amigável.
try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TimeRemainingColumn
    from rich.table import Table
    from rich.theme import Theme

    custom_theme = Theme({
        "info": "cyan",
        "success": "bold green",
        "warning": "yellow",
        "error": "bold red",
        "step": "bold magenta",
    })
    console = Console(theme=custom_theme)
    HAS_RICH = True
except ImportError:
    console = None
    HAS_RICH = False


def log_step(step_number: int, total_steps: int, title: str):
    """Exibe o cabeçalho de uma etapa do processo."""
    text = f"[{step_number}/{total_steps}] {title}"
    if HAS_RICH and console:
        console.print(f"\n[step]▶ {text}[/step]")
    else:
        print(f"\n>>> {text}")


def log_success(msg: str):
    """Exibe mensagem de sucesso."""
    if HAS_RICH and console:
        console.print(f"[success]✔ {msg}[/success]")
    else:
        print(f"✔ {msg}")


def log_error(msg: str):
    """Exibe mensagem de erro."""
    if HAS_RICH and console:
        console.print(f"[error]✖ {msg}[/error]", stderr=True)
    else:
        print(f"✖ {msg}", file=sys.stderr)


def log_info(msg: str):
    """Exibe mensagem informativa."""
    if HAS_RICH and console:
        console.print(f"[info]ℹ {msg}[/info]")
    else:
        print(f"ℹ {msg}")


def check_ffmpeg():
    """Verifica se o FFmpeg está disponível no sistema."""
    if not shutil.which("ffmpeg"):
        raise RuntimeError(
            "O FFmpeg não foi encontrado no sistema.\n"
            "Por favor, instale o FFmpeg e adicione seu executável à variável de ambiente PATH."
        )


def extract_audio(video_path: Path, output_audio_path: Path) -> Path:
    """
    Etapa 1: Extrai o áudio do vídeo no formato WAV mono 16000Hz.
    """
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

    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, command, output=result.stdout, stderr=result.stderr)

    return output_audio_path


def detect_silence_and_duration(
    audio_path: Path,
    threshold_db: float = -40.0,
    min_silence_ms: float = 500.0,
) -> Tuple[List[Tuple[float, float]], float]:
    """
    Etapa 2: Detecta intervalos de silêncio (start, end) e a duração total do áudio/vídeo
    usando o filtro 'silencedetect' do FFmpeg.
    """
    min_silence_sec = min_silence_ms / 1000.0
    command = [
        "ffmpeg",
        "-hide_banner",
        "-i", str(audio_path),
        "-af", f"silencedetect=noise={threshold_db}dB:d={min_silence_sec}",
        "-f", "null",
        "-",
    ]

    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stderr = result.stderr

    # Obter duração total do arquivo (ex: Duration: 00:01:30.50)
    duration_match = re.search(r"Duration:\s*(\d+):(\d+):([\d\.]+)", stderr)
    total_duration = 0.0
    if duration_match:
        hours = float(duration_match.group(1))
        minutes = float(duration_match.group(2))
        seconds = float(duration_match.group(3))
        total_duration = hours * 3600 + minutes * 60 + seconds

    # Detectar inícios e fins de silêncio
    silences: List[Tuple[float, float]] = []
    start_times = re.findall(r"silence_start:\s*([\d\.]+)", stderr)
    end_times = re.findall(r"silence_end:\s*([\d\.]+)", stderr)

    start_floats = [float(s) for s in start_times]
    end_floats = [float(e) for e in end_times]

    # Parear inícios e fins de silêncio
    for i in range(min(len(start_floats), len(end_floats))):
        s_start = start_floats[i]
        s_end = end_floats[i]
        if s_end > s_start:
            silences.append((s_start, s_end))

    # Tratar caso o silêncio vá até o final do vídeo
    if len(start_floats) > len(end_floats) and total_duration > 0:
        last_start = start_floats[-1]
        if total_duration > last_start:
            silences.append((last_start, total_duration))

    return silences, total_duration


def get_speech_segments(
    silences: List[Tuple[float, float]],
    total_duration: float,
    padding: float = 0.2,
) -> List[Tuple[float, float]]:
    """
    Calcula os intervalos de fala a serem mantidos com base no inverso dos silêncios
    e na aplicação do padding especificado.
    """
    if total_duration <= 0:
        return []

    # Clamp e ordenação de silêncios
    clamped_silences = []
    for s_start, s_end in silences:
        start = max(0.0, min(total_duration, float(s_start)))
        end = max(0.0, min(total_duration, float(s_end)))
        if end > start:
            clamped_silences.append((start, end))

    clamped_silences.sort(key=lambda x: x[0])

    # Mesclar silêncios sobrepostos
    merged_silences = []
    for start, end in clamped_silences:
        if not merged_silences:
            merged_silences.append((start, end))
        else:
            prev_start, prev_end = merged_silences[-1]
            if start <= prev_end:
                merged_silences[-1] = (prev_start, max(prev_end, end))
            else:
                merged_silences.append((start, end))

    # Inverso do silêncio = intervalos de fala
    raw_speech = []
    current_time = 0.0

    for s_start, s_end in merged_silences:
        if s_start > current_time:
            raw_speech.append((current_time, s_start))
        current_time = max(current_time, s_end)

    if current_time < total_duration:
        raw_speech.append((current_time, total_duration))

    # Aplicar padding e limitar a [0, total_duration]
    padded_speech = []
    for start, end in raw_speech:
        padded_start = max(0.0, start - padding)
        padded_end = min(total_duration, end + padding)
        if padded_end > padded_start:
            padded_speech.append((padded_start, padded_end))

    # Mesclar blocos de fala sobrepostos devido ao padding
    final_speech = []
    min_gap = 0.6  # Pausas de silêncio menores que 0.6s após padding são unificadas para ritmo natural e evitar cortes picotados
    for start, end in padded_speech:
        if not final_speech:
            final_speech.append((start, end))
        else:
            prev_start, prev_end = final_speech[-1]
            if start - prev_end < min_gap:
                final_speech[-1] = (prev_start, max(prev_end, end))
            else:
                final_speech.append((start, end))

    return [(round(s, 4), round(e, 4)) for s, e in final_speech]


def cut_and_concat(
    video_path: Path,
    speech_segments: List[Tuple[float, float]],
    output_path: Path,
) -> Path:
    """
    Etapa 3 & 4: Corta e mescla o vídeo em passagem única com precisão de frame
    utilizando script de filtro complexo do FFmpeg.
    """
    filter_file = Path("filter_script.txt")

    try:
        log_step(3, 4, "Gerando Filtro de Corte Preciso")
        total_chunks = len(speech_segments)

        filter_lines = []
        concat_inputs = []

        for k, (start, end) in enumerate(speech_segments):
            duration = max(0.0, end - start)
            if duration <= 0:
                continue
            filter_lines.append(f"[0:v]trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS[v{k}];")
            filter_lines.append(f"[0:a]atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS[a{k}];")
            concat_inputs.append(f"[v{k}][a{k}]")

        if not concat_inputs:
            raise ValueError("Nenhum trecho de fala válido pôde ser extraído do vídeo.")

        filter_lines.append(f"{''.join(concat_inputs)}concat=n={len(concat_inputs)}:v=1:a=1[outv][outa]")

        with open(filter_file, "w", encoding="utf-8") as f:
            f.write("\n".join(filter_lines))

        log_step(4, 4, "Renderizando Vídeo Final")
        log_info(f"Renderizando {len(concat_inputs)} trecho(s) com precisão milimétrica em '{output_path.name}'...")

        command = [
            "ffmpeg",
            "-y",
            "-i", str(video_path),
            "-filter_complex_script", str(filter_file),
            "-map", "[outv]",
            "-map", "[outa]",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-c:a", "aac",
            str(output_path),
        ]

        res = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if res.returncode != 0:
            raise subprocess.CalledProcessError(res.returncode, command, output=res.stdout, stderr=res.stderr)

        log_success(f"Vídeo final cortado gerado: {output_path}")
        return output_path

    finally:
        if filter_file.exists():
            try:
                filter_file.unlink()
            except Exception:
                pass


def format_duration(seconds: float) -> str:
    """Formata segundos para uma representação amigável (ex: 10m, 6m 30s ou 45s)."""
    seconds = max(0.0, seconds)
    total_sec = int(round(seconds))
    m, s = divmod(total_sec, 60)
    h, m = divmod(m, 60)

    if h > 0:
        return f"{h}h {m}m {s}s" if s > 0 else f"{h}h {m}m"
    if m > 0:
        return f"{m}m {s}s" if s > 0 else f"{m}m"
    return f"{s}s"


def print_summary(orig_sec: float, final_sec: float):
    """Exibe o sumário com o tempo economizado."""
    saved_sec = max(0.0, orig_sec - final_sec)

    orig_str = format_duration(orig_sec)
    final_str = format_duration(final_sec)
    saved_str = format_duration(saved_sec)

    summary_text = (
        f"Vídeo original: {orig_str}. "
        f"Vídeo final: {final_str}. "
        f"Tempo economizado: {saved_str}"
    )

    if HAS_RICH and console:
        table = Table(title="📊 Sumário do Auto-Cut Pro", style="cyan", show_header=True)
        table.add_column("Métrica", style="bold white")
        table.add_column("Valor", style="bold yellow")

        table.add_row("Vídeo original", orig_str)
        table.add_row("Vídeo final", final_str)
        table.add_row("Tempo economizado", f"[bold green]{saved_str}[/bold green]")

        console.print("\n")
        console.print(table)
        console.print(Panel(summary_text, title="Resumo do Processamento", border_style="green"))
    else:
        print("\n========================================")
        print("SUMMARY:")
        print(summary_text)
        print("========================================\n")


def main():
    parser = argparse.ArgumentParser(
        description="AutoCut Pro - Corte automático de silêncio em vídeos via FFmpeg.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "input_video",
        help="Caminho do arquivo de vídeo de entrada (ex: input.mp4)",
    )
    parser.add_argument(
        "-o",
        "--output",
        default="output.mp4",
        help="Caminho do vídeo final cortado",
    )
    parser.add_argument(
        "-db",
        "--threshold-db",
        type=float,
        default=-40.0,
        help="Limiar de ruído em dB para detecção de silêncio",
    )
    parser.add_argument(
        "-pad",
        "--padding",
        type=float,
        default=0.2,
        help="Segundos de padding ao redor dos blocos de fala",
    )
    parser.add_argument(
        "-min",
        "--min-silence-len",
        type=float,
        default=500.0,
        help="Duração mínima do silêncio em milissegundos",
    )

    args = parser.parse_args()

    input_path = Path(args.input_video)
    output_path = Path(args.output)
    temp_audio_path = Path("temp_audio.wav")

    try:
        # Validar FFmpeg e arquivo de entrada
        check_ffmpeg()

        if not input_path.is_file():
            log_error(f"O arquivo de vídeo '{input_path}' não existe ou não pôde ser encontrado.")
            sys.exit(1)

        log_info(f"Iniciando AutoCut Pro para '{input_path.name}'...")

        # Etapa 1: Extraindo Áudio
        log_step(1, 4, "Extraindo Áudio")
        extract_audio(input_path, temp_audio_path)
        log_success(f"Áudio extraído temporariamente em '{temp_audio_path.name}'")

        # Etapa 2: Detectando Silêncio
        log_step(2, 4, "Detectando Silêncio")
        silences, total_duration = detect_silence_and_duration(
            temp_audio_path,
            threshold_db=args.threshold_db,
            min_silence_ms=args.min_silence_len,
        )
        log_success(
            f"Duração total: {total_duration:.2f}s | "
            f"Silêncios detectados: {len(silences)} intervalo(s)"
        )

        # Calcular intervalos de fala
        speech_segments = get_speech_segments(
            silences,
            total_duration,
            padding=args.padding,
        )
        log_info(f"Trechos de fala identificados a serem mantidos: {len(speech_segments)}")

        # Etapa 3 & 4: Cortando Chunks e Mesclando
        cut_and_concat(input_path, speech_segments, output_path)

        # Calcular durações e imprimir sumário
        final_duration = sum(end - start for start, end in speech_segments)
        print_summary(total_duration, final_duration)

    except RuntimeError as err:
        log_error(str(err))
        sys.exit(1)
    except subprocess.CalledProcessError as err:
        log_error(f"Erro ao executar o comando FFmpeg: {err.stderr}")
        sys.exit(1)
    except Exception as err:
        log_error(f"Ocorreu um erro inesperado: {err}")
        sys.exit(1)
    finally:
        # Garantir remoção do áudio temporário
        if temp_audio_path.exists():
            try:
                temp_audio_path.unlink()
            except Exception:
                pass


if __name__ == "__main__":
    main()

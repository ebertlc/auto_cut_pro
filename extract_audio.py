import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Tuple


def is_ffmpeg_installed() -> bool:
    """
    Verifica se o ffmpeg está instalado e acessível no PATH do sistema.
    """
    return shutil.which("ffmpeg") is not None


def extract_audio(
    video_path: str, output_path: str = "temp_audio.wav"
) -> str:
    """
    Extrai o áudio de um arquivo de vídeo usando FFmpeg e salva como WAV mono 16000Hz.

    :param video_path: Caminho para o arquivo de vídeo de entrada.
    :param output_path: Caminho para o arquivo de áudio de saída (padrão: temp_audio.wav).
    :return: Caminho do arquivo de áudio gerado.
    :raises RuntimeError: Se o ffmpeg não estiver instalado.
    :raises FileNotFoundError: Se o arquivo de vídeo não existir.
    :raises subprocess.CalledProcessError: Se ocorrer um erro durante a execução do ffmpeg.
    """
    if not is_ffmpeg_installed():
        raise RuntimeError(
            "Erro: O FFmpeg não foi encontrado no sistema.\n"
            "Certifique-se de que o FFmpeg está instalado e adicionado às variáveis de ambiente (PATH)."
        )

    video_file = Path(video_path)
    if not video_file.is_file():
        raise FileNotFoundError(
            f"Erro: O arquivo de vídeo '{video_path}' não existe ou não é um arquivo válido."
        )

    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(video_file),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        output_path,
    ]

    try:
        print(f"Extraindo áudio de '{video_path}' para '{output_path}'...")
        subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True,
        )
        print(f"Áudio extraído com sucesso: {output_path}")
        return output_path

    except subprocess.CalledProcessError as e:
        print(f"Erro ao processar o vídeo com FFmpeg: {e.stderr}", file=sys.stderr)
        raise e


def get_speech_segments(
    silences: List[Tuple[float, float]],
    total_duration: float,
    padding: float = 0.2,
) -> List[Tuple[float, float]]:
    """
    Calcula os intervalos de fala a serem mantidos com base na lista de silêncios
    e na duração total do vídeo.

    :param silences: Lista de tuplas (inicio, fim) indicando intervalos de silêncio em segundos.
    :param total_duration: Duração total do vídeo em segundos.
    :param padding: Margem em segundos para expandir cada bloco de fala (padrão: 0.2s).
    :return: Lista de tuplas (start, end) dos blocos de fala ajustados e mesclados.
    """
    if total_duration <= 0:
        return []

    # 1. Ajustar e ordenar os silêncios dentro dos limites [0, total_duration]
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

    # 2. Obter os intervalos de fala brutos (inverso do silêncio)
    raw_speech = []
    current_time = 0.0

    for s_start, s_end in merged_silences:
        if s_start > current_time:
            raw_speech.append((current_time, s_start))
        current_time = max(current_time, s_end)

    if current_time < total_duration:
        raw_speech.append((current_time, total_duration))

    # 3. Aplicar padding nos blocos de fala e limitar entre 0 e total_duration
    padded_speech = []
    for start, end in raw_speech:
        padded_start = max(0.0, start - padding)
        padded_end = min(total_duration, end + padding)
        if padded_end > padded_start:
            padded_speech.append((padded_start, padded_end))

    # 4. Mesclar blocos de fala que se sobrepõem após o padding
    final_speech = []
    min_gap = 0.35  # Pausas de silêncio menores que 0.35s após padding são unificadas para evitar centenas de micro-cortes
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


def cut_video(
    video_path: str,
    speech_segments: List[Tuple[float, float]],
    output_path: str = "output.mp4",
) -> str:
    """
    Corta o vídeo original com base na lista de intervalos de fala (start, end).
    Executa a renderização precisa em passagem única via script de filtro complexo do FFmpeg.
    """
    if not is_ffmpeg_installed():
        raise RuntimeError("Erro: O FFmpeg não foi encontrado no sistema.")

    video_file = Path(video_path)
    if not video_file.is_file():
        raise FileNotFoundError(f"Erro: O arquivo de vídeo '{video_path}' não existe.")

    if not speech_segments:
        print("Nenhum segmento de fala fornecido. Nenhum vídeo gerado.")
        return output_path

    filter_file = Path("filter_script.txt")

    try:
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
            raise ValueError("Nenhum trecho de fala válido pôde ser extraído.")

        filter_lines.append(f"{''.join(concat_inputs)}concat=n={len(concat_inputs)}:v=1:a=1[outv][outa]")

        with open(filter_file, "w", encoding="utf-8") as f:
            f.write("\n".join(filter_lines))

        command = [
            "ffmpeg",
            "-y",
            "-i", str(video_file),
            "-filter_complex_script", str(filter_file),
            "-map", "[outv]",
            "-map", "[outa]",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-c:a", "aac",
            output_path,
        ]

        print(f"Renderizando {len(concat_inputs)} trecho(s) com corte preciso em '{output_path}'...")
        subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True,
        )

        print(f"Vídeo final gerado com sucesso: {output_path}")
        return output_path

    except subprocess.CalledProcessError as e:
        print(f"Erro na execução do FFmpeg durante o corte:\n{e.stderr}", file=sys.stderr)
        raise e

    finally:
        if filter_file.exists():
            try:
                filter_file.unlink()
            except Exception:
                pass


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: python extract_audio.py <caminho_do_video> [caminho_saida_wav]")
        print("Exemplo: python extract_audio.py input.mp4")
        sys.exit(1)

    input_video = sys.argv[1]
    output_audio = sys.argv[2] if len(sys.argv) > 2 else "temp_audio.wav"

    try:
        extract_audio(input_video, output_audio)
    except (RuntimeError, FileNotFoundError) as err:
        print(f"[-] {err}", file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError:
        print("[-] Falha na conversão de áudio via FFmpeg.", file=sys.stderr)
        sys.exit(1)

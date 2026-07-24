import unittest
from extract_audio import get_speech_segments


class TestSpeechSegments(unittest.TestCase):

    def test_basic_silence_removal(self):
        # Vídeo de 10s com silêncios em [2.0, 4.0] e [6.0, 8.0]
        silences = [(2.0, 4.0), (6.0, 8.0)]
        duration = 10.0
        padding = 0.2

        # Fala bruta: [(0, 2.0), (4.0, 6.0), (8.0, 10.0)]
        # Padded: [(0, 2.2), (3.8, 6.2), (7.8, 10.0)]
        expected = [(0.0, 2.2), (3.8, 6.2), (7.8, 10.0)]
        result = get_speech_segments(silences, duration, padding)
        self.assertEqual(result, expected)

    def test_overlapping_padding_merge(self):
        # Silêncio pequeno de 0.3s (de 2.0 a 2.3).
        # Fala bruta: [(0, 2.0), (2.3, 10.0)]
        # Padded: [(0, 2.2), (2.1, 10.0)] -> Sobreposição entre 2.1 e 2.2!
        # Esperado: Mesclar em [(0.0, 10.0)]
        silences = [(2.0, 2.3)]
        duration = 10.0
        padding = 0.2

        expected = [(0.0, 10.0)]
        result = get_speech_segments(silences, duration, padding)
        self.assertEqual(result, expected)

    def test_no_silences(self):
        # Sem silêncios: fala dura o vídeo inteiro
        silences = []
        duration = 15.0
        padding = 0.5

        expected = [(0.0, 15.0)]
        result = get_speech_segments(silences, duration, padding)
        self.assertEqual(result, expected)

    def test_full_silence(self):
        # O vídeo é inteiro de silêncio
        silences = [(0.0, 10.0)]
        duration = 10.0

        expected = []
        result = get_speech_segments(silences, duration)
        self.assertEqual(result, expected)

    def test_bounds_clamping(self):
        # Padding não deve exceder [0, total_duration]
        silences = [(5.0, 7.0)]
        duration = 10.0
        padding = 1.0

        # Fala bruta: [(0, 5.0), (7.0, 10.0)]
        # Padded: [(0, 6.0), (6.0, 10.0)] -> Sobrepõe em 6.0 -> Mescla em [(0, 10.0)]
        expected = [(0.0, 10.0)]
        result = get_speech_segments(silences, duration, padding)
        self.assertEqual(result, expected)


if __name__ == "__main__":
    unittest.main()

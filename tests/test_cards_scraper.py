import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
from io import BytesIO

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'model'))
import cards_scraper as scraper
from PIL import Image


class CardImageUpdateTests(unittest.TestCase):
    def test_existing_images_survive_a_partial_update_and_failed_cards_retry(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(scraper, 'CARDS_DIR', directory):
            old = pathlib.Path(directory) / 'rad-001.webp'
            Image.new('RGB', (80, 110), 'red').save(old, format='WEBP')
            original = old.read_bytes()
            cards = [{'id': 'rad-001', 'image_url': 'old'}, {'id': 'rad-219', 'image_url': 'new'}]
            with patch.object(scraper, '_download_single_image', return_value=('rad-219', False)) as download:
                self.assertEqual(scraper.download_images(cards), ['rad-219'])
                download.assert_called_once_with(cards[1])
            self.assertEqual(old.read_bytes(), original)
            with patch.object(scraper, '_download_single_image', return_value=('rad-219', True)) as download:
                self.assertEqual(scraper.download_images(cards), [])
                download.assert_called_once_with(cards[1])

    def test_interrupted_replacement_preserves_the_previous_image(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(scraper, 'CARDS_DIR', directory):
            old = pathlib.Path(directory) / 'rad-001.webp'
            old.write_bytes(b'previous image')
            with patch.object(scraper.SESSION, 'get', side_effect=OSError('offline')), patch.object(scraper.time, 'sleep'):
                self.assertEqual(scraper._download_single_image({'id': 'rad-001', 'image_url': 'new'}), ('rad-001', False))
            self.assertEqual(old.read_bytes(), b'previous image')
            self.assertFalse(pathlib.Path(str(old) + '.tmp').exists())

    def test_successful_landscape_download_is_stored_as_portrait(self):
        buffer = BytesIO()
        Image.new('RGB', (110, 80), 'blue').save(buffer, format='PNG')
        response = unittest.mock.Mock(content=buffer.getvalue())
        with tempfile.TemporaryDirectory() as directory, patch.object(scraper, 'CARDS_DIR', directory), patch.object(scraper.SESSION, 'get', return_value=response):
            self.assertEqual(scraper._download_single_image({'id': 'rad-001', 'image_url': 'new'}), ('rad-001', True))
            with Image.open(pathlib.Path(directory) / 'rad-001.webp') as image:
                self.assertLess(image.width, image.height)


if __name__ == '__main__':
    unittest.main()

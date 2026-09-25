import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer
import server
from overlay_store import OverlayStore, _RENDER_LOCK
from overlay_components import COMPONENTS

class SlimRoutesTest(unittest.TestCase):
    def test_retained_features_and_removed_routes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            with patch.multiple(server, EVENT_LIBRARY=root/'events', OUTPUT_DIR=root/'outputs', OVERLAYS=OverlayStore(root/'overlays'), SETTINGS_FILE=root/'settings.json', HISTORY_FILE=root/'history.json'):
                server.clear_data_cache()
                http=ThreadingHTTPServer(('127.0.0.1',0),server.WorkbenchHandler)
                t=threading.Thread(target=http.serve_forever);t.start()
                base=f'http://127.0.0.1:{http.server_port}'
                try:
                    for path in ['/library','/voiceover','/clips','/overlays','/topics']:
                        with urlopen(base+path) as r: self.assertEqual(r.status,200)
                    for path in ['/studio','/edit','/studio.html','/edit.js','/api/studio/bootstrap']:
                        with self.assertRaises(HTTPError) as caught: urlopen(base+path)
                        self.assertEqual(caught.exception.code,404)
                        caught.exception.close()
                    for path in ['/api/edit/render','/api/edit/preview','/api/edit/transcribe','/api/studio/upload']:
                        with self.assertRaises(HTTPError) as caught:
                            urlopen(Request(base+path,data=b'{}',headers={'Content-Type':'application/json'}))
                        self.assertEqual(caught.exception.code,404)
                        caught.exception.close()
                    with urlopen(Request(base+'/api/overlays',data=b'{"title":"test","component":"cascade_stack"}',headers={'Content-Type':'application/json'})) as r:
                        self.assertEqual(r.status,200)
                    with urlopen(base+'/api/overlays') as r:
                        data=json.load(r)
                        self.assertEqual(len(data['components']),9)
                        self.assertEqual(len(data['instances']),1)
                finally:
                    http.shutdown();t.join();http.server_close()
    def test_renderer_scripts_are_packaged(self):
        store=OverlayStore(Path('/unused'))
        for component in COMPONENTS.values(): self.assertTrue(store.script_for(component).is_file())
    def test_parallel_render_is_rejected_before_touching_files(self):
        with _RENDER_LOCK:
            with self.assertRaisesRegex(ValueError,'正在导出'):
                OverlayStore(Path('/unused')).render_instance('test')

if __name__=='__main__': unittest.main()

class RenderCacheTest(unittest.TestCase):
    def test_formats_cache_and_invalidation(self):
        import io
        from PIL import Image
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            store=OverlayStore(Path(tmp))
            instance=store.create_instance('test',{},'cascade_stack')
            for slot in range(1,5):
                buf=io.BytesIO();Image.new('RGB',(32,32),(slot*40,20,10)).save(buf,format='PNG')
                store.save_image(instance['id'],slot,'test.png',buf.getvalue())
            def fake_render(command, **kwargs):
                output=Path(command[command.index('--out')+1])
                kind=command[command.index('--formats')+1]
                self.assertNotIn(',',kind)
                from overlay_store import OUTPUT_NAMES
                (output/OUTPUT_NAMES[kind]).write_bytes(b'encoded-test')
                return subprocess.CompletedProcess(command,0,'','')
            with patch('overlay_store.subprocess.run',side_effect=fake_render) as render:
                a=store.render_instance(instance['id'],['preview']);self.assertFalse(a['cacheHit'])
                self.assertEqual(set(a['outputs']),{'preview'})
                store.save_instance(instance['id'],'renamed',instance['params'])
                self.assertTrue(store.render_instance(instance['id'],['preview'])['cacheHit'])
                self.assertEqual(render.call_count,1)
                b=store.render_instance(instance['id'],['webm']);self.assertEqual(set(b['outputs']),{'preview','webm'})
                self.assertEqual(render.call_count,2)
                store.save_instance(instance['id'],None,{**instance['params'],'hold':2.5})
                self.assertFalse(store.public_instance(store.instance_dir(instance['id']))['outputs'])
                self.assertFalse(store.render_instance(instance['id'],['preview'])['cacheHit'])
                self.assertEqual(render.call_count,3)
                # A same-name image replacement must invalidate the cache as well.
                buf=io.BytesIO();Image.new('RGB',(32,32),'white').save(buf,format='PNG')
                store.save_image(instance['id'],1,'test.png',buf.getvalue())
                self.assertFalse(store.public_instance(store.instance_dir(instance['id']))['outputs'])
                with self.assertRaises(ValueError): store.render_instance(instance['id'],['preview','webm'])

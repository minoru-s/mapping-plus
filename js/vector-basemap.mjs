import { maplibreGL as createLayer } from 'https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.4/dist/leaflet-maplibre-gl.mjs';
import { setWorkerUrl } from 'maplibre-gl';

setWorkerUrl(new URL('./maplibre-worker.mjs', import.meta.url).href);
export function maplibreGL(options) {
  const layer = createLayer(options);
  const onRemove = layer.onRemove;
  layer.onRemove = function(map) {
    // If WebGL initialization throws before a GL map exists, let Leaflet still
    // finish removing the layer and its registered zoom/move event handlers.
    if (this.getMaplibreMap()) onRemove.call(this, map);
    else this.getContainer()?.remove();
  };
  return layer;
}

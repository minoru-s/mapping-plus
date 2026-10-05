// Share the existing Leaflet instance with the ES-module MapLibre adapter.
// Loading a second Leaflet copy would give the two renderers separate state.
export default window.L;

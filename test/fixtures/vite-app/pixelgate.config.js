// Visual gate of the pixelgate repo itself: .github/workflows/visual.yml runs the
// pixelgate GitHub Action (action.yml) on this app for every pull request.
// The e2e tests do not read this file; they pass their own config.
export default {
  vite: { mode: 'preview' },
  targets: { desktop: { viewport: '640x400' } },
  pages: [{ name: 'plans', url: '/', selector: '.card' }],
};

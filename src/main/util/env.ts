export const is = {
  dev: Boolean(process.env['ELECTRON_RENDERER_URL']) || process.env.NODE_ENV === 'development',
};

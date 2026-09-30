/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import preact from '@preact/preset-vite';

// VITE_ROUTER, se valorizzata (es. https://192.168.10.1), fa da proxy verso il
// router vero durante lo sviluppo. Se non c'e', il client ubus usa il
// simulatore in src/lib/mock.ts e si lavora senza dispositivo.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const router = env.VITE_ROUTER;

  return {
    // L'app vive in /www/travel/ sul router: LuCI resta dov'e', intatta.
    base: '/travel/',
    plugins: [preact()],
    server: {
      host: true,
      proxy: router
        ? {
            '/ubus': {
              target: router,
              changeOrigin: true,
              // Il router usa un certificato self-signed: in sviluppo lo accettiamo.
              secure: false,
            },
          }
        : undefined,
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2020',
      // Il router serve questi file da flash a un telefono: teniamo tutto compatto.
      chunkSizeWarningLimit: 300,
    },
    test: {
      // I test cercano i testi italiani: la lingua si fissa li', invece di
      // dipendere da quella del browser simulato (jsdom parla inglese).
      setupFiles: ['tests/setup.ts'],
    },
  };
});

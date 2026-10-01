// Vite が CSS の import を処理する
declare module '*.css'

interface ImportMeta {
  readonly env: { readonly DEV: boolean }
}

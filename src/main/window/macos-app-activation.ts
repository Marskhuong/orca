export function createMacAppActivationHandler(options: {
  requestActivation: () => void
}): () => void {
  // A live renderer may still have a hidden or minimized native window.
  return () => options.requestActivation()
}

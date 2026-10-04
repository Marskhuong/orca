export function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')
  )
}

export function isMissingError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

// Why: localized permission errors keep these .NET/ACL markers even when the PowerShell text is mojibake.
export function isWindowsUserPathPermissionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
  const haystack = `${error.message}\n${stderr}`
  return (
    haystack.includes('UnauthorizedAccessException') ||
    haystack.includes('SecurityException') ||
    haystack.includes('Requested registry access is not allowed') ||
    haystack.includes('Access is denied') ||
    haystack.includes('Access to the registry key')
  )
}

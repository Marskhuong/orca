import { useEffect, useState } from 'react'
import type { FooterBalance } from '../../../../shared/footer-balance-types'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
export function useFooterBalances(rateLimits: RateLimitState): FooterBalance[] {
  const [balances, setBalances] = useState<FooterBalance[]>([])
  useEffect(() => {
    let current = true
    const load = window.api?.rateLimits?.getFooterBalances
    if (load) {
      void load()
        .then((result) => {
          if (current) {
            setBalances(Array.isArray(result) ? result : [])
          }
        })
        .catch(() => {
          if (current) {
            setBalances([])
          }
        })
    }
    return () => {
      current = false
    }
  }, [rateLimits])
  return balances
}

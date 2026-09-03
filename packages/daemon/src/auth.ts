import { OmniError, type ResolvedDaemonConfig, type TokenId } from "@omni-acp/protocol";
import type { AuthContext } from "./types.js";

export interface TokenStore {
  /**
   * Throws `unauthorized`. Re-evaluated on EVERY request and never cached: mutating the token
   * table must change the next verdict with no restart (DESIGN §8). Comparison is
   * `timingSafeEqual` over the SHA-256 digests; the plaintext secret is hashed at config load
   * and dropped.
   */
  verify(headers: Headers): AuthContext;
  has(tokenId: TokenId): boolean;
}

export function createTokenStore(config: ResolvedDaemonConfig): TokenStore {
  throw new OmniError("internal", "unimplemented: WP-5 (daemon.createTokenStore)");
}

# Security Policy

Clad sits between AI agents and real financial data, so security reports are
welcome and taken seriously. This document explains what to report, how, and
what the project does and does not currently claim to protect against.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report privately through GitHub:

1. Go to the [Security tab](https://github.com/nd4spd13/agentic-finance/security/advisories)
2. Click **Report a vulnerability**

This opens a private advisory visible only to you and the maintainer. If private
reporting is unavailable, open a public issue containing only the words "security
report — please open a private channel" and no technical detail, and a private
advisory will be started.

Useful reports include the affected version or commit, affected component
(policy engine, MCP server, OAuth/consent flow, token store, adapters, desktop
app), reproduction steps, and the impact you believe it has.

### What to expect

Clad is maintained by one person, so all timelines are best effort rather than a
contractual SLA:

- **Acknowledgement:** typically within a few days.
- **Assessment:** an initial severity judgement and whether it is in scope.
- **Fix and disclosure:** coordinated with you. Credit is given in the advisory
  unless you would rather stay anonymous.

Please allow a reasonable window to ship a fix before publishing details.

## Supported versions

Clad is pre-1.0 and moves quickly. Only the **most recent release** receives
security fixes; there are no long-term support branches. Older versions,
including previously downloaded desktop builds, are not patched in place.

## Scope

**In scope** — the security properties Clad actively tries to hold:

- Policy bypass: any way to make an agent take an action the policy should have
  denied (spending limits, merchant/category rules, schedules, escalation).
- Failing open: any path where a malformed, unparseable, or partially-applied
  policy results in permitted rather than denied.
- OAuth and consent flaws: PKCE or DPoP bypass, authorization-code replay,
  scope escalation, defeating the set-once client-to-profile binding, or a
  revoked or denied grant continuing to work.
- Credential and token exposure: recovering stored access tokens or
  passphrases, or leaking them into logs, error messages, or UI surfaces.
- Data exfiltration: routing financial data somewhere the policy did not permit.
- Approval-flow forgery: approving a pending action without the user's consent.

**Out of scope** — known and documented, not vulnerabilities:

- **Unsigned desktop builds.** Releases are currently ad-hoc signed, so macOS
  Gatekeeper flags them and the documented `xattr` step is required. Signing and
  notarization are on the roadmap. The related caveat that Keychain-backed
  secrets may need re-entry after an update is expected behavior on unsigned
  builds, as described in the README.
- Anything requiring an attacker who already has local code execution or read
  access to the user's account. Clad's stores are encrypted at rest, but a
  compromised user account is outside the threat model.
- Advisories in development-only dependencies (test and build tooling) that are
  not present in any shipped artifact. CI gates on production dependencies;
  Dependabot tracks the rest.
- Behavior of upstream providers (Plaid, SimpleFIN) or of the AI agent itself.
  Report those to the relevant vendor — though if Clad *enables* the problem,
  that is in scope.
- Missing hardening with no demonstrated impact. A concrete attack path is much
  more actionable than a scanner finding.

## Current security posture

Honest statement of where the project stands, so reports can be calibrated:

- **Deny-by-default policy engine.** Actions not explicitly permitted are denied.
- **OAuth 2.1 with PKCE and DPoP.** Agents authenticate as a bound profile;
  tokens are opaque and stored hashed. Tool calls are governed by the
  OAuth-bound profile, not by a client-supplied identity.
- **Encrypted at rest.** Token and grant stores are passphrase-encrypted SQLite
  with enforced file modes; on desktop the passphrase is held via Electron
  `safeStorage`.
- **Secret redaction** on the paths that write logs and errors.
- **Bank data.** Plaid runs against the Sandbox environment. Treat the project
  as beta and prefer sandbox or test credentials.

Clad has **not** had a third-party security audit. It is a working beta, not a
hardened production system, and should be evaluated accordingly.

## Good-faith research

Testing against your own installation and your own sandbox accounts is welcome.
Please don't test against other people's accounts or real financial
institutions, don't run denial-of-service or automated scanning against
third-party providers, and don't access or retain data that isn't yours. Reports
made in good faith under these terms will not be pursued.

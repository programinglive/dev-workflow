# Open-Source Dependency & License Compliance Review

**Document Version:** 1.0.0  
**Selected Public License:** MIT License  
**Package Name:** `dev-workflow` / `@devworkflow/core`  

---

## 1. Third-Party Dependency License Audit

All direct runtime dependencies and devDependencies in `package.json` have been audited for open-source compatibility:

| Dependency | Version | License | Compatibility with MIT Core | Notes |
|---|---|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.0.0` | MIT | COMPATIBLE | Official Anthropic MCP specification SDK |
| `better-sqlite3` | `^12.11.1` | MIT | COMPATIBLE | Local C++ SQLite binding |
| `dotenv` | `^18.0.9` | BSD-2-Clause | COMPATIBLE | Environment variable parsing |
| `mysql2` | `^3.15.3` | MIT | COMPATIBLE | Optional MySQL adapter |
| `pg` | `^8.23.1` | MIT | COMPATIBLE | Optional PostgreSQL adapter |
| `vite` | `^7.1.12` | MIT | COMPATIBLE | Development and bundler tool |
| `@commitlint/cli` | `^21.2.4` | MIT | COMPATIBLE | Dev dependency |
| `husky` | `^9.1.7` | MIT | COMPATIBLE | Git hooks |
| `standard-version` | `^9.5.0` | Apache-2.0 | COMPATIBLE | Semver versioning |
| `supertest` | `^7.3.1` | MIT | COMPATIBLE | Test runner assertion |

### Assessment Result: **100% COMPLIANT**
Zero viral copyleft (GPL / AGPL) dependencies exist in the runtime dependency tree. The MIT license is fully legally viable for the public distribution.

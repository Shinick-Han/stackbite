# npm setup fixture measurement

Measured on 2026-10-08, Windows x64, Node v24.19.0, with
`node packaging/npm/test/measure-setup.js`. The deterministic fixture has 37 files,
2,100,751 expanded bytes and a 2,106,990-byte ZIP. Download is a local fake write;
warm launch uses an inert child stub. No release download, provider, backend or
installed state is used. These numbers do not predict production bundle timings.

| Cold preparation stage | Milliseconds |
| --- | ---: |
| Fake download/write | 1.51 |
| Archive boundary SHA/size verification | 3.50 |
| Bounded preflight and native extraction | 78.05 |
| Staging payload validation | 31.11 |
| Cache publication | 0.72 |
| Published payload validation | 28.29 |
| Total, including cache setup and staging cleanup | 148.31 |

Five warm offline checks took 30.87, 30.96, 29.66, 30.26 and 28.80 ms
(median 30.26 ms). Five warm launches with the inert child took 30.99, 36.36,
31.27, 29.06 and 29.33 ms (median 30.99 ms). Warm paths hash all pinned files,
walk the complete inventory and validate identity and link boundaries; they do
not download or extract.

The cold path deliberately retains both payload validations: staging validation
prevents publishing a bad extraction, and final-path validation checks the actual
published directory, including a concurrent install winner. Archive hashing at
the extraction boundary also remains in place even if the transport verified the
download. A local completion marker or unchanged timestamps cannot establish
integrity; the tests reject same-size tampering with restored timestamps.

A candidate optimization for separate review is a bounded queue of file hash
reads during full payload validation. It would retain the pinned manifest and
metadata checks, every file digest, the complete inventory, per-file and total
size limits, link resolution checks and executable identity. A small concurrency
limit would bound descriptors and buffered bytes. It needs measurements on real
Windows/Linux bundles and tampering/link/concurrency regression checks before
adoption; this assignment does not change the verification algorithm or promise
a speedup. Setup moves preparation into an explicit command, while every warm
launch still performs full verification.

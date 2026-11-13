#!/bin/bash
# OpenSSL CMS AuthEnvelopedData; RSA-OAEP/SHA256 + AES-256-GCM.
# Only the public recipient certificate is present on CI. Never uploads plaintext.
set -eu -o pipefail
umask 077
: "${RUNNER_TEMP:?}"
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CERT="$D/diagnostics-recipient.pem"
PRIV="$RUNNER_TEMP/private-diagnostics"
PUB="$RUNNER_TEMP/public-summary"
ERR="$RUNNER_TEMP/diagnostics-seal.stderr"
if test ! -d "$PRIV"; then echo 'diagnostics=absent'; exit 0; fi
if ! python3 -I - "$CERT" <<'PYVERIFY'
import hashlib,sys
from pathlib import Path
p=Path(sys.argv[1]);sys.exit(not (not p.is_symlink() and hashlib.sha256(p.read_bytes()).hexdigest() == '3dd53013ff2a4670174a2e7f7a863143db4aa99b6abf3601851d45e903e4827d'))
PYVERIFY
then echo 'diagnostics=certificate_refused'; exit 1; fi
SSL=""
for candidate in /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
  if test -x "$candidate"; then SSL="$candidate"; break; fi
done
if test -z "$SSL"; then SSL="$(command -v openssl || true)"; fi
if test -z "$SSL"; then echo 'diagnostics=openssl_unavailable'; exit 1; fi
case "$("$SSL" version 2>/dev/null)" in 'OpenSSL 3.'*) ;; *) echo 'diagnostics=openssl_version_refused'; exit 1;; esac
if ! "$SSL" x509 -in "$CERT" -noout -checkend 0 > /dev/null 2> "$ERR"; then
  echo 'diagnostics=certificate_expired'; exit 1
fi
# Pack a fixed allowlist; no symlinks, source checkout, key files or arbitrary paths.
if ! python3 -I - "$PRIV" 2>> "$ERR" <<'PYPACK'
import os,stat,sys,tarfile
from pathlib import Path
p=Path(sys.argv[1]); allowed=['job.stderr','state.txt','toolchain.log','list.txt','ignored.txt','build.log','full-lib.log']+[f'focus-{i}.log' for i in range(1,5)]
total=0
with tarfile.open(p/'diagnostics-payload.tar','w',format=tarfile.PAX_FORMAT) as t:
    for name in allowed:
        f=p/name
        if not f.exists():continue
        st=f.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_size > 64*1024*1024:raise ValueError('refused')
        total+=st.st_size
        if total > 256*1024*1024:raise ValueError('refused')
        t.add(f,arcname=name,recursive=False)
PYPACK
then echo 'diagnostics=archive_refused'; exit 1; fi
mkdir -p "$PUB"
TMP="$PUB/.private-diagnostics.cms.part"
trap 'rm -f "$TMP"' EXIT
if ! "$SSL" cms -encrypt -binary -aes-256-gcm -outform DER \
  -in "$PRIV/diagnostics-payload.tar" -out "$TMP" -recip "$CERT" \
  -keyopt rsa_padding_mode:oaep -keyopt rsa_oaep_md:sha256 2>> "$ERR"; then
  echo 'diagnostics=encryption_failed'; exit 1
fi
mv "$TMP" "$PUB/private-diagnostics.cms"
python3 -I - "$PUB/private-diagnostics.cms" '3dd53013ff2a4670174a2e7f7a863143db4aa99b6abf3601851d45e903e4827d' <<'PYMETA'
import hashlib,json,sys
from pathlib import Path
p=Path(sys.argv[1]); m={'format':'openssl-cms-authenveloped-der','cipher':'AES-256-GCM','recipient':'RSA-3072-OAEP-SHA256','recipient_certificate_sha256':sys.argv[2],'ciphertext_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'ciphertext_bytes':p.stat().st_size,'plaintext_uploaded':False}
p.with_name('diagnostics-envelope.json').write_text(json.dumps(m,indent=2)+'\n',encoding='utf-8')
PYMETA
echo 'diagnostics=encrypted'

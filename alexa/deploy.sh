#!/usr/bin/env bash
# Create or update the development Alexa skill that points at your tunnel. Needs `ask configure` once.
#   alexa/deploy.sh https://<your-tunnel>.trycloudflare.com
# Writes the skill id to alexa/.skill-id (gitignored). The skill stays in the development stage, which
# is enough to use it on every Echo signed in to the same Amazon account.
set -euo pipefail
cd "$(dirname "$0")"
BASE=${1:?usage: deploy.sh https://tunnel-origin}
MAN=$(mktemp); sed "s#__ENDPOINT__#${BASE%/}/alexa#" skill-package/skill.json > "$MAN"
if [ -s .skill-id ]; then
  ID=$(cat .skill-id)
  ask smapi update-skill-manifest -s "$ID" -g development --manifest "file:$MAN" >/dev/null
else
  ID=$(ask smapi create-skill-for-vendor --manifest "file:$MAN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).skillId))')
  echo "$ID" > .skill-id
fi
for i in $(seq 1 30); do
  st=$(ask smapi get-skill-status -s "$ID" --resource manifest | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).manifest?.lastUpdateRequest?.status??""))')
  [ "$st" = "SUCCEEDED" ] && break; [ "$st" = "FAILED" ] && { ask smapi get-skill-status -s "$ID"; exit 1; }; sleep 2
done
for L in en-US en-IN en-GB en-AU en-CA; do
  ask smapi set-interaction-model -s "$ID" -g development -l $L --interaction-model "file:skill-package/interactionModels/custom/$L.json" >/dev/null
  for i in $(seq 1 60); do
    st=$(ask smapi get-skill-status -s "$ID" --resource interactionModel | L=$L node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s).interactionModel??{};console.log(m[process.env.L]?.lastUpdateRequest?.status??"")})')
    [ "$st" = "SUCCEEDED" ] && break; [ "$st" = "FAILED" ] && { ask smapi get-skill-status -s "$ID"; exit 1; }; sleep 3
  done
done
ask smapi set-skill-enablement -s "$ID" -g development >/dev/null 2>&1 || true
echo "skill $ID ready, endpoint ${BASE%/}/alexa"

#!/usr/bin/env bash
#
# free.ai image tools — curl-like interface, no sign-in needed.
# Usage: ./submit.sh <command> [args]
#
# Text-to-Image:
#   ./submit.sh ai-art "a cat in space" [--model MODEL] [--aspect R] [--count N] [--out FILE]
#
# Image Processing (file upload):
#   ./submit.sh remove-bg photo.jpg [--out FILE]
#   ./submit.sh upscale photo.jpg [--scale 2|--scale 4] [--out FILE]
#   ./submit.sh enhance photo.jpg [--out FILE]
#   ./submit.sh object-remove photo.jpg [--out FILE]
#   ./submit.sh face-swap src.jpg target.jpg [--out FILE]
#   ./submit.sh edit photo.jpg "prompt" [--out FILE]
#
# Helpers:
#   ./submit.sh list          — list all tools
#   ./submit.sh models        — list available models

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ $# -eq 0 ]; then
  cat <<'EOF'
free.ai Image Tools — No sign-in required

Usage: ./submit.sh <command> [arguments]

TEXT-TO-IMAGE:
  ai-art "prompt"                     Generate image from text
    --model MODEL          sdxl|flux2-klein|qwen7b (default: sdxl)
    --aspect RATIO         1:1|16:9|9:16|4:3|3:4|21:9 (default: 1:1)
    --count N              1 or 4 (default: 1)
    --out FILE             output file (default: output.png)

IMAGE PROCESSING:
  remove-bg photo.jpg              Remove background
  upscale photo.jpg [opts]          Upscale resolution
    --scale 2|4               (default: 2)
  enhance photo.jpg                Sharpen & enhance
  object-remove photo.jpg          Remove objects
  face-swap src.jpg tgt.jpg         Swap faces
  edit photo.jpg "prompt"          General edit

HELP:
  list                              Show all tools
  models                            Show available models

Examples:
  ./submit.sh ai-art "a cyberpunk cat" --model flux2-klein --aspect 16:9
  ./submit.sh remove-bg photo.jpg --out clean.png
  ./submit.sh upscale photo.jpg --scale 4 --out big.png
  ./submit.sh face-swap me.jpg star.jpg --out swapped.png
EOF
  exit 0
fi

CMD="$1"
shift

# Translate to node submit.js format
ARGS=()

case "$CMD" in
  ai-art|generate|gen|g)
    ARGS+=("generate")
    ;;
  remove-bg|remove_bg|bg|background-remover)
    ARGS+=("remove-bg")
    ;;
  upscale|upscaler)
    ARGS+=("upscale")
    ;;
  enhance|image-enhance)
    ARGS+=("enhance")
    ;;
  object-remove|object_remove|object-remover)
    ARGS+=("object-remove")
    ;;
  face-swap|face_swap|fs)
    ARGS+=("face-swap")
    ;;
  edit|image-edit)
    ARGS+=("edit")
    ;;
  list|tools)
    node "$DIR/submit.js" list
    exit 0
    ;;
  models)
    node "$DIR/submit.js" models
    exit 0
    ;;
  help|-h|--help)
    # Re-run this script with no args to show help
    exec "$0"
    ;;
  *)
    echo "❌ Unknown command: $CMD"
    echo "Run '$0' with no arguments for usage."
    exit 1
    ;;
esac

# Process arguments
while [ $# -gt 0 ]; do
  case "$1" in
    --model|-m)
      ARGS+=("--model" "$2")
      shift 2
      ;;
    --aspect|-ar)
      ARGS+=("--aspect" "$2")
      shift 2
      ;;
    --count|-n)
      ARGS+=("--count" "$2")
      shift 2
      ;;
    --scale|-s)
      ARGS+=("--scale" "$2")
      shift 2
      ;;
    --out|-o)
      ARGS+=("--output" "$2")
      shift 2
      ;;
    --negative|-neg)
      ARGS+=("--negative" "$2")
      shift 2
      ;;
    --mood)
      ARGS+=("--mood" "$2")
      shift 2
      ;;
    --*)
      echo "❌ Unknown option: $1"
      exit 1
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

node "$DIR/submit.js" "${ARGS[@]}"

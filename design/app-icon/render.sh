#!/usr/bin/env bash
# Render the OcuSmart app icon into the iOS asset catalog.
# Needs rsvg-convert (librsvg) and ImageMagick 7 (magick).
#
# Default and dark appearances use the same dark artwork; tinted is the
# greyscale version iOS recolours. The default icon must be opaque, so alpha
# is flattened onto the background's bottom colour.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../../App_Resources/iOS/Assets.xcassets/AppIcon.appiconset"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

render() { # name bg_top bg_bottom glyph accent
  sed -e "s/BG_TOP/$2/; s/BG_BOTTOM/$3/; s/GLYPH/$4/g; s/ACCENT/$5/" "$here/twin-lens.svg" > "$tmp/$1.svg"
  rsvg-convert -w 1024 -h 1024 "$tmp/$1.svg" -o "$tmp/$1.png"
  magick "$tmp/$1.png" -background "$3" -alpha remove -alpha off -strip "PNG24:$out/$1.png"
}

render AppIcon        '#232326' '#050506' '#5AB0FF' '#BFE0FF'
render AppIcon-Dark   '#232326' '#050506' '#5AB0FF' '#BFE0FF'
render AppIcon-Tinted '#3A3A3C' '#141416' '#E5E5EA' '#9A9AA0'
ls -la "$out"

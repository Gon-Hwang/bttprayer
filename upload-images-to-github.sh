#!/bin/bash

# GitHub images 업로드 — 토큰은 프로젝트 루트의 .env 에서 읽습니다.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/.env"
  set +a
fi

GITHUB_USER="${GITHUB_USER:-Gon-Hwang}"
GITHUB_REPO="${GITHUB_REPO:-bttprayer}"
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"

if [ -z "$GITHUB_TOKEN" ] || [ "$GITHUB_TOKEN" = "여기에_토큰_붙여넣기" ]; then
  echo "❌ .env 파일에 GITHUB_TOKEN을 설정하세요. (.env.example 참고)"
  exit 1
fi

echo "🖼️  GitHub에 images/ 폴더 업로드 시작..."

# Base64 인코딩 함수
base64_encode() {
    if command -v base64 &> /dev/null; then
        base64 -w 0 "$1" 2>/dev/null || base64 "$1"
    else
        openssl base64 -A -in "$1"
    fi
}

# 파일 업로드 함수
upload_file() {
    local file_path="$1"
    local github_path="$2"
    
    echo "📤 업로드 중: $github_path"
    
    # 파일을 Base64로 인코딩
    local content=$(base64_encode "$file_path")
    
    # GitHub API로 파일 업로드
    curl -X PUT \
        -H "Authorization: token $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github.v3+json" \
        "https://api.github.com/repos/$GITHUB_USER/$GITHUB_REPO/contents/$github_path" \
        -d "{
            \"message\": \"Add $github_path\",
            \"content\": \"$content\",
            \"branch\": \"$GITHUB_BRANCH\"
        }" \
        --silent --show-error | grep -q '"path"' && echo "   ✅ 성공!" || echo "   ❌ 실패 (이미 존재할 수 있음)"
}

# images/ 폴더의 각 파일 업로드
upload_file "images/logo.png" "images/logo.png"
upload_file "images/logo-transparent.png" "images/logo-transparent.png"
upload_file "images/logo-new.png" "images/logo-new.png"

echo ""
echo "🎉 images/ 폴더 업로드 완료!"
echo "🌐 확인: https://github.com/$GITHUB_USER/$GITHUB_REPO"

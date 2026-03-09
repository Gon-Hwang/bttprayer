#!/bin/bash

# GitHub 정보
GITHUB_TOKEN="ghp_kJm8Cu1oBY8kUv6HkA1PSHvJLmK3HxIz7A5X"
GITHUB_USER="Gon-Hwang"
GITHUB_REPO="bttprayer"
GITHUB_BRANCH="main"

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

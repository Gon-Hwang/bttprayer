#!/bin/bash

# GitHub 업로드 스크립트 — 토큰은 프로젝트 루트의 .env 에서 읽습니다.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/.env"
  set +a
fi

GITHUB_USER="${GITHUB_USER:-Gon-Hwang}"
GITHUB_REPO="${GITHUB_REPO:-bttprayer}"

if [ -z "$GITHUB_TOKEN" ] || [ "$GITHUB_TOKEN" = "여기에_토큰_붙여넣기" ]; then
  echo "❌ .env 파일에 GITHUB_TOKEN을 설정하세요. (.env.example 참고)"
  exit 1
fi

echo "🚀 GitHub 저장소에 파일 업로드 시작..."

# Git 설정
git config --global user.email "your-email@example.com"
git config --global user.name "Gon-Hwang"

# Git 초기화
git init
echo "✅ Git 초기화 완료"

# 원격 저장소 추가 (토큰 포함)
git remote remove origin 2>/dev/null
git remote add origin "https://${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${GITHUB_REPO}.git"
echo "✅ 원격 저장소 연결 완료"

# 모든 파일 추가
git add .
echo "✅ 파일 추가 완료"

# 커밋
git commit -m "Initial commit: BTT Prayer Website

- 메인 웹사이트 및 관리자 도구
- 스타일시트 및 JavaScript
- 이미지 및 리소스 파일
- README 및 문서
"
echo "✅ 커밋 완료"

# 푸시
git branch -M main
git push -u origin main --force

echo "🎉 GitHub 업로드 완료!"
echo "🌐 저장소: https://github.com/${GITHUB_USER}/${GITHUB_REPO}"

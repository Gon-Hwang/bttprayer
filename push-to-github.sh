#!/bin/bash

# BTT Prayer 프로젝트 GitHub 업로드 스크립트

echo "🚀 GitHub 저장소로 푸시 준비중..."

# Git 초기화 (이미 있다면 스킵)
if [ ! -d .git ]; then
    git init
    echo "✅ Git 저장소 초기화 완료"
fi

# 원격 저장소 설정
git remote remove origin 2>/dev/null
git remote add origin https://github.com/Gon-Hwang/bttprayer.git
echo "✅ 원격 저장소 설정 완료"

# 모든 파일 추가
git add .
echo "✅ 파일 추가 완료"

# 커밋
git commit -m "Initial commit: BTT Prayer website

- 메인 웹사이트 (index.html)
- 관리자 도구 (admin-password-reset.html, send-sms.html)
- 테스트 페이지 (test-email.html, test-admin.html, test-schedule.html)
- 스타일시트 (css/style.css)
- JavaScript (js/main.js)
- 이미지 및 파비콘
- README 문서
"
echo "✅ 커밋 완료"

# 푸시 (main 브랜치)
echo "📤 GitHub로 푸시 중..."
git branch -M main
git push -u origin main

echo "🎉 GitHub 업로드 완료!"
echo "🌐 저장소: https://github.com/Gon-Hwang/bttprayer"

#!/bin/zsh

cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo "未找到 python3。请先安装 Python 3，或在终端确认 python3 可用。"
  echo
  read "reply?按回车关闭..."
  exit 1
fi

python3 server.py "$@"
status=$?

echo
if [ "$status" -eq 0 ]; then
  echo "Lyra 已退出。"
else
  echo "Lyra 异常退出，退出码：$status"
fi
read "reply?按回车关闭..."
exit "$status"

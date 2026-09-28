#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 cubelightt

# 模拟 cs2-server(msm fork)CLI,用于无真实主机时全链路验证。
# 用法与真实一致:@<instance> <start|stop|restart|status|send|matchcleanup|clone|delete> [args...]
# 状态文件在 ${ARENA_STUB_DIR:-/tmp/arena-stub}/<name>.state;send 记录到 <name>.log
# clone/delete(M5 建删实例)在 **cwd(msm_dir)的兄弟目录 msm.d/cs2** 下建删实例布局
#   —— 与主机布局一致(<msm_dir>/../msm.d/cs2/{cfg/inst-<name>,inst-<name>}),故桥的步骤机可全链路验证。
# 可选旋钮:STUB_BOOT_S(start/restart 的启动耗时,默认 2)、STUB_CLONE_SLEEP_S(clone 前额外睡眠,
#   跨进程取消的 e2e 用例靠它把「任务运行中」的窗口拉长)
set -u

STUB_DIR="${ARENA_STUB_DIR:-/tmp/arena-stub}"
BOOT_S="${STUB_BOOT_S:-2}"
name="${1#@}"
op="$2"
shift 2
mkdir -p "$STUB_DIR"

state_file="$STUB_DIR/$name.state"
log_file="$STUB_DIR/$name.log"

state() {
  if [ -f "$state_file" ]; then
    cat "$state_file"
  else
    echo "STOPPED"
  fi
}

# 启动项覆盖(真实 msm:命令行环境变量 MAXPLAYERS 优先于 preset 弱默认)
start_line="START"
[ -n "${MAXPLAYERS:-}" ] && start_line="START MAXPLAYERS=${MAXPLAYERS}"

case "$op" in
  start)
    if [ "$(state)" = "RUNNING" ]; then echo "RUNNING"; exit 0; fi
    echo "BOOTING" > "$state_file"
    echo "[$(date +%H:%M:%S)] $start_line" >> "$log_file"
    sleep "$BOOT_S"
    echo "RUNNING" > "$state_file"
    echo "RUNNING"
    ;;
  stop)
    echo "STOPPED" > "$state_file"
    echo "[$(date +%H:%M:%S)] STOP" >> "$log_file"
    echo "STOPPED"
    ;;
  restart)
    echo "BOOTING" > "$state_file"
    echo "[$(date +%H:%M:%S)] RESTART${MAXPLAYERS:+ MAXPLAYERS=$MAXPLAYERS}" >> "$log_file"
    sleep "$BOOT_S"
    echo "RUNNING" > "$state_file"
    echo "RUNNING"
    ;;
  status)
    state
    ;;
  send)
    args="$*"
    echo "[$(date +%H:%M:%S)] SEND: $args" >> "$log_file"
    case "$args" in
      matchzy_loadmatch\ *)
        # 模拟 matchzy_loadmatch <file>:读取后端写入的比赛 JSON 文件(相对 csgo/ 目录)
        file="${args#matchzy_loadmatch }"
        if [ -f "$STUB_DIR/$file" ]; then
          echo "[$(date +%H:%M:%S)] LOADMATCH OK $file" >> "$log_file"
          echo "OK"
        else
          echo "[$(date +%H:%M:%S)] LOADMATCH FAIL no-file $file" >> "$log_file"
          echo "FAIL no-file" >&2
          exit 1
        fi
        ;;
      arena_match_load\ *)
        # 模拟 arena_match_load <id>: 检查 stub 目录下是否存在 .arena-match/match_<id>.json
        mid="${args#arena_match_load }"
        if [ -f "$STUB_DIR/.arena-match/match_$mid.json" ]; then
          echo "[$(date +%H:%M:%S)] ARENA_MATCH_LOAD OK $mid" >> "$log_file"
          echo "OK"
        else
          echo "[$(date +%H:%M:%S)] ARENA_MATCH_LOAD FAIL no-file match_$mid.json" >> "$log_file"
          echo "FAIL no-file" >&2
          exit 1
        fi
        ;;
      matchzy_loadmatch_url\ *)
        # 兼容旧流程(模拟游戏服务器主动 GET)
        url="${args#matchzy_loadmatch_url }"
        code=$(curl -s -o "$STUB_DIR/last-match.json" -w '%{http_code}' --max-time 15 "$url" 2>/dev/null || echo 000)
        if [ "$code" = "200" ]; then
          echo "[$(date +%H:%M:%S)] LOADMATCH OK" >> "$log_file"
          echo "OK"
        else
          echo "[$(date +%H:%M:%S)] LOADMATCH FAIL $code" >> "$log_file"
          echo "FAIL $code" >&2
          exit 1
        fi
        ;;
      *)
        echo "OK"
        ;;
    esac
    ;;
  clone)
    # @<src> clone <name>:建目标实例的 cfg + 实例目录(端口取第一个未占用的 27015+)
    target="${1:-}"
    [ -n "$target" ] || { echo "clone needs <name>" >&2; exit 2; }
    # e2e 跨进程取消用例:让 clone 步骤持续足够久,便于在任务运行期间发起取消
    [ -n "${STUB_CLONE_SLEEP_S:-}" ] && sleep "$STUB_CLONE_SLEEP_S"
    cs2="$(cd "$(pwd)/.." && pwd)/msm.d/cs2"
    [ -d "$cs2/cfg" ] || { echo "no msm layout at $cs2" >&2; exit 1; }
    [ -d "$cs2/cfg/inst-$target" ] && { echo "instance $target exists" >&2; exit 1; }

    # 端口分配:扫描现有 cfg/inst-*/server.conf 的 PORT=(含 GOTV=PORT+100),取第一个空位
    # 取**最后**一条 PORT=:server.conf 是 bash 源文件(后赋值生效),且 msm 会把强 PORT=
    # 追加在文件末尾 —— 取第一条会读到该实例早先/继承来的旧端口。
    port=27015
    while :; do
      busy=0
      for f in "$cs2"/cfg/inst-*/server.conf; do
        [ -f "$f" ] || continue
        p=$(sed -n 's/^[[:space:]]*PORT="\{0,1\}\([0-9]\{2,5\}\)"\{0,1\}[[:space:]]*$/\1/p' "$f" | tail -1)
        [ -n "$p" ] || continue
        if [ "$p" = "$port" ] || [ "$((p + 100))" = "$port" ] || [ "$port" = "$((p + 100))" ]; then busy=1; break; fi
      done
      [ "$busy" = "0" ] && break
      port=$((port + 1))
    done

    mkdir -p "$cs2/cfg/inst-$target" "$cs2/inst-$target/game/csgo/addons" "$cs2/inst-$target/game/bin/linuxsteamrt64/steamapps"
    # 与真机 msm 的 clone 同形:先整体拷来源配置(内含来源自己的 PORT=),再在**文件末尾**
    # 追加本次分配的强 PORT=(= msm App::assignInstancePort 的"末尾追加强覆盖")。
    # 于是新实例的 server.conf 里有**两条** PORT=,真端口是最后那条 —— 这是真机 clone 的
    # 真实形态,也是"回读端口"必须取最后一条匹配的原因(取第一条会读到来源实例的端口)。
    if [ -f "$cs2/cfg/inst-$name/server.conf" ]; then
      cp -f "$cs2/cfg/inst-$name/server.conf" "$cs2/cfg/inst-$target/server.conf" 2>/dev/null
    fi
    printf 'SM_SWIFTLYS2=1\n' >> "$cs2/cfg/inst-$target/server.conf"
    {
      echo ""
      echo "# Auto-assigned by stub clone (= msm create/clone 的末尾强覆盖)"
      echo "PORT=\"$port\""
    } >> "$cs2/cfg/inst-$target/server.conf"
    [ -d "$cs2/inst-$name/game/csgo/addons" ] && cp -a "$cs2/inst-$name/game/csgo/addons/." "$cs2/inst-$target/game/csgo/addons/" 2>/dev/null
    echo "[$(date +%H:%M:%S)] CLONE from=$name to=$target port=$port" >> "$STUB_DIR/$name.log"
    echo "OK clone $target port=$port"
    ;;
  delete)
    # @<any> delete <name>:真删目标实例的 cfg 与实例目录
    target="${1:-}"
    [ -n "$target" ] || { echo "delete needs <name>" >&2; exit 2; }
    cs2="$(cd "$(pwd)/.." && pwd)/msm.d/cs2"
    freed=0
    for d in "$cs2/cfg/inst-$target" "$cs2/inst-$target"; do
      [ -e "$d" ] || continue
      sz=$(du -sk "$d" 2>/dev/null | awk '{print $1}')
      freed=$((freed + ${sz:-0}))
      rm -rf "$d"
    done
    echo "[$(date +%H:%M:%S)] DELETE $target freedKb=$freed" >> "$STUB_DIR/$name.log"
    echo "OK delete $target freedKb=$freed"
    ;;
  matchcleanup)
    # 模拟桥的 matchcleanup(比赛结束后清理 MatchZy 中间产物 + 归档平台比赛 JSON):
    #   @<inst> matchcleanup <matchId>|all
    # 删除:MatchZyDataBackup/matchzy_<id>_*.json、matchzy_<id>_*.txt、MatchZyPlayerNames/Match_<id>.ini、
    #       引擎 backup_round*.txt;归档:matchzy_load_<id>.json → <STUB_DIR>/arena-data/matchjson/<inst>/
    id="${1:-}"
    [ -n "$id" ] || { echo "matchcleanup needs <matchId>|all" >&2; exit 2; }
    arch="$STUB_DIR/arena-data/matchjson/$name"
    mkdir -p "$arch"
    deleted=0; moved=0
    if [ "$id" = "all" ]; then
      for f in "$STUB_DIR"/MatchZyDataBackup/matchzy_*.json "$STUB_DIR"/matchzy_*_round*.txt "$STUB_DIR"/MatchZyPlayerNames/Match_*.ini "$STUB_DIR"/backup_round*.txt; do
        [ -e "$f" ] || continue; rm -f "$f"; deleted=$((deleted + 1))
      done
      for f in "$STUB_DIR"/matchzy_load_*.json; do
        [ -f "$f" ] || continue; mv -f "$f" "$arch/"; moved=$((moved + 1))
      done
    else
      for f in "$STUB_DIR"/MatchZyDataBackup/matchzy_"$id"_*.json "$STUB_DIR"/matchzy_"$id"_*.txt "$STUB_DIR"/MatchZyPlayerNames/Match_"$id".ini "$STUB_DIR"/backup_round*.txt; do
        [ -e "$f" ] || continue; rm -f "$f"; deleted=$((deleted + 1))
      done
      for f in "$STUB_DIR"/matchzy_load_"$id".json; do
        [ -f "$f" ] || continue; mv -f "$f" "$arch/"; moved=$((moved + 1))
      done
    fi
    echo "[$(date +%H:%M:%S)] MATCHCLEANUP $id deleted=$deleted moved=$moved" >> "$log_file"
    echo "OK deleted=$deleted moved=$moved"
    ;;
  *)
    echo "unknown op: $op" >&2
    exit 1
    ;;
esac

#!/bin/sh

# 服务器部署脚本
# 用途：从 Docker Hub 拉取最新镜像并部署
# 兼容：sh, bash, zsh

set -e

# ==================== 工具函数 ====================

# 打印彩色消息（兼容 sh）
print_color() {
  color_code="$1"
  message="$2"
  printf "\033[%sm%s\033[0m\n" "$color_code" "$message"
}

print_info() {
  print_color "0;34" "$1"
}

print_success() {
  print_color "0;32" "$1"
}

print_warning() {
  print_color "1;33" "$1"
}

print_error() {
  print_color "0;31" "$1"
}

# 读取用户输入（兼容 sh）
read_input() {
  prompt="$1"
  default="$2"
  printf "%s" "$prompt" >&2
  read value
  if [ -z "$value" ] && [ -n "$default" ]; then
    echo "$default"
  else
    echo "$value"
  fi
}

# 验证端口号
validate_port() {
  port="$1"
  if [ -z "$port" ]; then
    return 1
  fi
  # 检查是否为数字
  case "$port" in
    ''|*[!0-9]*) return 1 ;;
  esac
  # 检查端口范围 (1-65535)
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    return 1
  fi
  return 0
}

# 检查端口是否被占用
check_port_available() {
  port="$1"
  if command -v lsof > /dev/null 2>&1; then
    if lsof -Pi ":$port" -sTCP:LISTEN -t > /dev/null 2>&1; then
      return 1
    fi
  elif command -v netstat > /dev/null 2>&1; then
    if netstat -tuln 2>/dev/null | grep -q ":$port "; then
      return 1
    fi
  fi
  return 0
}

# ==================== 主程序 ====================

print_info "========================================"
print_info "   Kerkerker 服务器部署脚本"
print_info "========================================"
printf "\n"

# 检查 Docker 是否运行
print_info "🔍 检查 Docker 状态..."
if ! docker info > /dev/null 2>&1; then
  print_error "❌ Docker 未运行，请先启动 Docker"
  exit 1
fi
print_success "✅ Docker 运行正常"
printf "\n"

# 加载环境变量（如果 .env 文件存在）
if [ -f .env ]; then
  print_info "📄 加载 .env 配置文件..."
  set -a
  . ./.env
  set +a
  print_success "✅ 配置文件加载成功"
else
  print_warning "⚠️  未找到 .env 文件，将使用交互式配置"
fi
printf "\n"

# ==================== 配置 Docker Hub 用户名 ====================
print_info "📦 配置 Docker 镜像信息"
print_info "----------------------------------------"

if [ -z "$DOCKER_USERNAME" ]; then
  print_warning "⚠️  未设置 DOCKER_USERNAME 环境变量"
  while [ -z "$DOCKER_USERNAME" ]; do
    printf "请输入 Docker Hub 用户名: "
    read DOCKER_USERNAME
    if [ -z "$DOCKER_USERNAME" ]; then
      print_error "❌ Docker Hub 用户名不能为空"
    fi
  done
  export DOCKER_USERNAME
  print_success "✅ Docker Hub 用户名: $DOCKER_USERNAME"
else
  print_success "✅ Docker Hub 用户名: $DOCKER_USERNAME"
fi

# ==================== 配置镜像版本 ====================
printf "请输入要部署的镜像版本 (默认: latest): "
read VERSION
if [ -z "$VERSION" ]; then
  VERSION="latest"
fi
export IMAGE_VERSION="$VERSION"
IMAGE_NAME="${DOCKER_USERNAME}/kerkerker:${VERSION}"
print_success "✅ 镜像: $IMAGE_NAME"
printf "\n"

# ==================== 配置应用端口 ====================
print_info "🌐 配置应用端口"
print_info "----------------------------------------"

# 显示当前端口配置
if [ -n "$APP_PORT" ]; then
  print_info "当前 .env 中配置的端口: $APP_PORT"
fi

# 询问用户是否使用自定义端口
printf "请输入应用端口 (默认: 3000): "
read APP_PORT
if [ -z "$APP_PORT" ]; then
  APP_PORT="3000"
fi

# 验证端口号
while ! validate_port "$APP_PORT"; do
  print_error "❌ 无效的端口号，请输入 1-65535 之间的数字"
  printf "请输入应用端口 (默认: 3000): "
  read APP_PORT
  if [ -z "$APP_PORT" ]; then
    APP_PORT="3000"
  fi
done

# 检查端口是否被占用
if ! check_port_available "$APP_PORT"; then
  print_warning "⚠️  警告: 端口 $APP_PORT 可能已被占用"
  printf "是否继续使用此端口？(y/N): "
  read CONTINUE
  if [ -z "$CONTINUE" ]; then
    CONTINUE="N"
  fi
  case "$CONTINUE" in
    [Yy]|[Yy][Ee][Ss]) ;;
    *)
      print_error "❌ 取消部署"
      exit 1
      ;;
  esac
fi

export APP_PORT
print_success "✅ 应用端口: $APP_PORT"
printf "\n"

# ==================== 检查必需的环境变量 ====================
print_info "🔐 检查环境变量配置"
print_info "----------------------------------------"

MISSING_VARS=""
if [ -z "$ADMIN_PASSWORD" ]; then
  MISSING_VARS="${MISSING_VARS}  - ADMIN_PASSWORD\n"
fi
if [ -z "$TMDB_PLUGIN_SERVICE_TOKEN" ]; then
  MISSING_VARS="${MISSING_VARS}  - TMDB_PLUGIN_SERVICE_TOKEN\n"
fi

if [ -n "$MISSING_VARS" ]; then
  print_warning "⚠️  警告：以下环境变量未设置："
  printf "%b" "$MISSING_VARS"
  print_warning "建议创建 .env 文件并配置这些变量"
  printf "\n"
  printf "是否继续部署？(y/N): "
  read CONTINUE
  if [ -z "$CONTINUE" ]; then
    CONTINUE="N"
  fi
  case "$CONTINUE" in
    [Yy]|[Yy][Ee][Ss]) ;;
    *)
      print_error "❌ 取消部署"
      exit 1
      ;;
  esac
else
  print_success "✅ 所有必需的环境变量已配置"
fi
printf "\n"

# ==================== 显示部署信息 ====================
print_info "📋 部署信息摘要"
print_info "========================================"
printf "  镜像:       %s\n" "$IMAGE_NAME"
printf "  应用端口:   %s\n" "$APP_PORT"
printf "  环境:       生产环境\n"
print_info "========================================"
printf "\n"

# 确认部署
printf "确认部署？(y/N): "
read CONFIRM
if [ -z "$CONFIRM" ]; then
  CONFIRM="N"
fi
case "$CONFIRM" in
  [Yy]|[Yy][Ee][Ss]) ;;
  *)
    print_warning "⚠️  取消部署"
    exit 0
    ;;
esac
printf "\n"

# ==================== 执行部署 ====================

# 停止旧容器
print_info "🛑 停止旧容器..."
docker-compose -f docker-compose.server.yml down 2>/dev/null || true
print_success "✅ 旧容器已停止"
printf "\n"

# 拉取最新镜像
print_info "📥 拉取镜像 $IMAGE_NAME..."
if docker pull "$IMAGE_NAME"; then
  print_success "✅ 镜像拉取成功"
else
  print_error "❌ 镜像拉取失败"
  exit 1
fi
printf "\n"

# 启动服务
print_info "🚀 启动服务..."
if docker-compose -f docker-compose.server.yml up -d; then
  print_success "✅ 服务启动成功"
else
  print_error "❌ 服务启动失败"
  exit 1
fi
printf "\n"

# 等待服务启动
print_info "⏳ 等待服务启动..."
sleep 10

# 健康检查
print_info "🏥 执行健康检查..."
HEALTH_CHECK_PASSED=0
i=1
while [ $i -le 10 ]; do
  if curl -f --noproxy localhost "http://localhost:${APP_PORT}/api/health" > /dev/null 2>&1; then
    print_success "✅ 健康检查通过！"
    HEALTH_CHECK_PASSED=1
    break
  fi
  print_warning "⏳ 重试 $i/10..."
  sleep 3
  i=$((i + 1))
done

if [ $HEALTH_CHECK_PASSED -eq 0 ]; then
  print_error "❌ 健康检查失败，请查看日志"
  docker-compose -f docker-compose.server.yml logs app
  exit 1
fi
printf "\n"

# 显示服务状态
print_info "📊 服务状态："
docker-compose -f docker-compose.server.yml ps
printf "\n"

# 清理旧镜像
print_info "🧹 清理未使用的镜像..."
docker image prune -f > /dev/null 2>&1
print_success "✅ 清理完成"
printf "\n"

# ==================== 部署完成 ====================

print_success "========================================"
print_success "✅ 部署成功！"
print_success "========================================"
printf "\n"

print_info "📝 常用命令："
printf "  查看日志:  docker-compose -f docker-compose.server.yml logs -f app\n"
printf "  停止服务:  docker-compose -f docker-compose.server.yml down\n"
printf "  重启服务:  docker-compose -f docker-compose.server.yml restart\n"
printf "  查看状态:  docker-compose -f docker-compose.server.yml ps\n"
printf "\n"

print_info "🌐 访问地址："
printf "  应用:      http://localhost:%s\n" "$APP_PORT"
printf "  健康检查:  http://localhost:%s/api/health\n" "$APP_PORT"
printf "\n"

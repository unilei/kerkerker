#!/bin/bash

# ============================================================
# Kerkerker 一键部署脚本
# ============================================================
# 使用方法:
#   curl -fsSL https://raw.githubusercontent.com/unilei/kerkerker/main/scripts/install.sh | bash
#   或
#   wget -qO- https://raw.githubusercontent.com/unilei/kerkerker/main/scripts/install.sh | bash
# ============================================================

set -e

# ==================== 颜色定义 ====================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ==================== 配置 ====================
DOCKER_IMAGE="unilei/kerkerker"
DEFAULT_VERSION="latest"
DEFAULT_PORT="3000"
INSTALL_DIR="${KERKERKER_INSTALL_DIR:-$HOME/kerkerker}"

# 默认 API 配置（可在部署后修改 .env 文件）
DEFAULT_TMDB_API_KEY="eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJhNDI5MzgwNWRjZjMwZTkzOTlhMWEwNThkNjc2MGI3MyIsIm5iZiI6MTc2NTYyNzUwMi4yOTIsInN1YiI6IjY5M2Q1NjZlZDNhNjZmNmFmMjVkZmJmNSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.8b41vbX0gowzxnoggdDbyjsUD1Vu7Fpl4qwwx0SiZOM"
DEFAULT_DOUBAN_API_PROXY="https://douban-proxy.ahagwybwqs.workers.dev"

# ==================== 工具函数 ====================
print_banner() {
    echo -e "${CYAN}"
    echo -e "╔═══════════════════════════════════════════════════════════╗"
    echo -e "║                                                           ║"
    echo -e "║   ${BOLD}🎬 Kerkerker 一键部署脚本${NC}${CYAN}                              ║"
    echo -e "║                                                           ║"
    echo -e "║   短剧/影视管理平台                                       ║"
    echo -e "║                                                           ║"
    echo -e "╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

print_step() {
    echo -e "\n${BLUE}==>${NC} ${BOLD}$1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ${NC}  $1"
}

print_success() {
    echo -e "${GREEN}✔${NC}  $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC}  $1"
}

print_error() {
    echo -e "${RED}✖${NC}  $1"
}

# 读取用户输入（支持默认值和密码模式）
# 注意：从 /dev/tty 读取，以支持 curl | bash 方式运行
read_input() {
    local prompt="$1"
    local default="$2"
    local is_password="$3"
    local value=""
    
    if [ -n "$default" ]; then
        prompt="${prompt} [${default}]"
    fi
    
    if [ "$is_password" = "true" ]; then
        echo -n -e "${CYAN}?${NC} ${prompt}: " >&2
        read -s value < /dev/tty
        echo "" >&2
    else
        echo -n -e "${CYAN}?${NC} ${prompt}: " >&2
        read value < /dev/tty
    fi
    
    if [ -z "$value" ] && [ -n "$default" ]; then
        echo "$default"
    else
        echo "$value"
    fi
}

# 验证端口号
validate_port() {
    local port="$1"
    if [[ ! "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
        return 1
    fi
    return 0
}

# 检查命令是否存在
command_exists() {
    command -v "$1" > /dev/null 2>&1
}

# ==================== 检查依赖 ====================
check_dependencies() {
    print_step "检查系统依赖"
    
    local missing_deps=()
    
    # 检查 Docker
    if ! command_exists docker; then
        missing_deps+=("docker")
    else
        print_success "Docker 已安装"
    fi
    
    # 检查 Docker Compose
    if command_exists docker-compose; then
        print_success "Docker Compose 已安装 (standalone)"
        COMPOSE_CMD="docker-compose"
    elif docker compose version > /dev/null 2>&1; then
        print_success "Docker Compose 已安装 (plugin)"
        COMPOSE_CMD="docker compose"
    else
        missing_deps+=("docker-compose")
    fi
    
    # 检查 curl
    if ! command_exists curl; then
        print_warning "curl 未安装（健康检查将跳过）"
    else
        print_success "curl 已安装"
    fi
    
    # 如果有缺失的依赖
    if [ ${#missing_deps[@]} -gt 0 ]; then
        echo ""
        print_error "缺少以下依赖:"
        for dep in "${missing_deps[@]}"; do
            echo "   - $dep"
        done
        echo ""
        print_info "请先安装 Docker 和 Docker Compose:"
        echo "   https://docs.docker.com/get-docker/"
        exit 1
    fi
    
    # 检查 Docker 是否运行
    if ! docker info > /dev/null 2>&1; then
        print_error "Docker 未运行，请先启动 Docker"
        exit 1
    fi
    print_success "Docker 运行正常"
}

# ==================== 交互式配置 ====================
interactive_config() {
    print_step "配置部署参数"
    echo ""
    print_info "请根据提示输入配置信息（直接回车使用默认值）"
    echo ""
    
    # 安装目录
    INSTALL_DIR=$(read_input "安装目录" "$INSTALL_DIR")
    
    # 应用端口
    while true; do
        APP_PORT=$(read_input "应用端口" "$DEFAULT_PORT")
        if validate_port "$APP_PORT"; then
            break
        fi
        print_error "无效的端口号，请输入 1-65535 之间的数字"
    done
    
    # 镜像版本
    IMAGE_VERSION=$(read_input "镜像版本" "$DEFAULT_VERSION")
    
    echo ""
    print_info "以下为可选配置（直接回车使用默认值，部署后可在 .env 中修改）"
    echo ""
    
    # 管理员密码
    ADMIN_PASSWORD=$(read_input "管理员密码" "admin123" "true")
    
    # 使用默认 API 配置
    TMDB_API_KEY="$DEFAULT_TMDB_API_KEY"
    DOUBAN_API_PROXY="$DEFAULT_DOUBAN_API_PROXY"
    
    # 确认配置
    echo ""
    print_step "配置确认"
    echo ""
    echo -e "   ${BOLD}安装目录:${NC}       $INSTALL_DIR"
    echo -e "   ${BOLD}应用端口:${NC}       $APP_PORT"
    echo -e "   ${BOLD}镜像版本:${NC}       $DOCKER_IMAGE:$IMAGE_VERSION"
    echo -e "   ${BOLD}管理员密码:${NC}     已设置"
    echo -e "   ${BOLD}TMDB API:${NC}       已配置默认值"
    echo -e "   ${BOLD}豆瓣代理:${NC}       已配置默认值"
    echo ""
    print_info "💡 提示: TMDB API 和豆瓣代理已预配置，部署后可在 .env 中修改"
    echo ""
    
    local confirm=$(read_input "确认以上配置并开始部署? (y/n)" "y")
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        print_warning "已取消部署"
        exit 0
    fi
}

# ==================== 创建配置文件 ====================
create_config_files() {
    print_step "创建配置文件"
    
    # 创建安装目录
    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    print_success "创建目录: $INSTALL_DIR"
    
    # 创建 .env 文件
    cat > .env << EOF
# ============================================================
# Kerkerker 环境配置
# 生成时间: $(date '+%Y-%m-%d %H:%M:%S')
# ============================================================
# 修改配置后请执行: ./kerkerker.sh restart
# ============================================================

# ==================== Docker 镜像配置 ====================
DOCKER_USERNAME=unilei
IMAGE_VERSION=${IMAGE_VERSION}

# ==================== 应用配置 ====================
APP_PORT=${APP_PORT}
NODE_ENV=production

# ==================== 安全配置 ====================
# 管理员密码（访问 /login 页面时使用）
ADMIN_PASSWORD=${ADMIN_PASSWORD}

# ==================== TMDB API 配置 ====================
# TMDB API Key (Bearer Token)
# 用于获取影视详情、海报、评分等信息
# 如需更换，请访问: https://www.themoviedb.org/settings/api
TMDB_API_KEY=${TMDB_API_KEY}
TMDB_BASE_URL=https://api.themoviedb.org/3
TMDB_IMAGE_BASE=https://image.tmdb.org/t/p/original

# ==================== 豆瓣 API 代理配置 ====================
# Cloudflare Workers 代理（解决豆瓣 API 的 IP 限制问题）
# 支持配置多个代理地址，用逗号分隔，系统会随机负载均衡
# 如需自己部署代理，请参考: https://github.com/unilei/kerkerker#-豆瓣-api-代理
DOUBAN_API_PROXY=${DOUBAN_API_PROXY}
EOF
    print_success "创建 .env 配置文件"
    
    # 创建 docker-compose.yml
    cat > docker-compose.yml << 'EOF'
# Kerkerker Docker Compose 配置
# 自动生成，请勿手动修改结构

services:
  # Next.js 应用
  app:
    image: ${DOCKER_USERNAME:-unilei}/kerkerker:${IMAGE_VERSION:-latest}
    container_name: kerkerker-app
    ports:
      - "${APP_PORT:-3000}:3000"
    environment:
      - NODE_ENV=production
      - ADMIN_PASSWORD=${ADMIN_PASSWORD}
      - MONGODB_URI=mongodb://mongodb:27017/kerkerker
      - TMDB_API_KEY=${TMDB_API_KEY}
      - TMDB_BASE_URL=${TMDB_BASE_URL}
      - TMDB_IMAGE_BASE=${TMDB_IMAGE_BASE}
      - DOUBAN_API_PROXY=${DOUBAN_API_PROXY}
      - REDIS_URL=redis://redis:6379
    depends_on:
      redis:
        condition: service_healthy
      mongodb:
        condition: service_healthy
    networks:
      - kerkerker-network
    restart: unless-stopped

  # Redis 缓存
  redis:
    image: redis:7-alpine
    container_name: kerkerker-redis
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    networks:
      - kerkerker-network
    restart: unless-stopped

  # MongoDB 数据库
  mongodb:
    image: mongo:7
    container_name: kerkerker-mongodb
    environment:
      - MONGO_INITDB_DATABASE=kerkerker
    volumes:
      - mongodb-data:/data/db
      - mongodb-config:/data/configdb
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - kerkerker-network
    restart: unless-stopped

networks:
  kerkerker-network:
    driver: bridge

volumes:
  redis-data:
  mongodb-data:
  mongodb-config:
EOF
    print_success "创建 docker-compose.yml"
    
    # 创建管理脚本
    cat > kerkerker.sh << 'SCRIPT'
#!/bin/bash

# Kerkerker 管理脚本
cd "$(dirname "$0")"

case "$1" in
    start)
        echo "🚀 启动服务..."
        docker compose up -d
        ;;
    stop)
        echo "🛑 停止服务..."
        docker compose down
        ;;
    restart)
        echo "🔄 重启服务..."
        echo "🗑️  清空 Redis 缓存..."
        docker compose exec -T redis redis-cli FLUSHALL > /dev/null 2>&1 || true
        docker compose restart app
        echo "✅ 重启完成"
        ;;
    logs)
        docker compose logs -f ${2:-app}
        ;;
    status)
        docker compose ps
        ;;
    update)
        echo "📥 更新镜像..."
        docker compose pull app
        echo "🔄 重启服务..."
        docker compose up -d
        echo "🧹 清理旧镜像..."
        docker image prune -f
        echo "✅ 更新完成"
        ;;
    backup)
        echo "📦 备份数据..."
        BACKUP_DIR="./backups/$(date +%Y%m%d_%H%M%S)"
        mkdir -p "$BACKUP_DIR"
        docker compose exec -T mongodb mongodump --archive > "$BACKUP_DIR/mongodb.archive"
        cp .env "$BACKUP_DIR/.env"
        echo "✅ 备份完成: $BACKUP_DIR"
        ;;
    *)
        echo "Kerkerker 管理脚本"
        echo ""
        echo "用法: ./kerkerker.sh <命令>"
        echo ""
        echo "命令:"
        echo "  start    启动服务"
        echo "  stop     停止服务"
        echo "  restart  重启服务"
        echo "  logs     查看日志 (可选参数: app/redis/mongodb)"
        echo "  status   查看状态"
        echo "  update   更新到最新版本"
        echo "  backup   备份数据"
        ;;
esac
SCRIPT
    chmod +x kerkerker.sh
    print_success "创建管理脚本 kerkerker.sh"
}

# ==================== 部署服务 ====================
deploy_services() {
    print_step "部署服务"
    
    cd "$INSTALL_DIR"
    
    # 拉取镜像
    print_info "拉取 Docker 镜像..."
    if $COMPOSE_CMD pull; then
        print_success "镜像拉取完成"
    else
        print_error "镜像拉取失败"
        exit 1
    fi
    
    # 启动服务
    print_info "启动服务..."
    if $COMPOSE_CMD up -d; then
        print_success "服务启动成功"
    else
        print_error "服务启动失败"
        exit 1
    fi
    
    # 等待服务就绪
    print_info "等待服务就绪..."
    sleep 15
    
    # 健康检查
    if command_exists curl; then
        print_info "执行健康检查..."
        local retries=10
        local success=false
        
        for i in $(seq 1 $retries); do
            if curl -sf "http://localhost:${APP_PORT}/api/health" > /dev/null 2>&1; then
                success=true
                break
            fi
            echo -n "."
            sleep 3
        done
        echo ""
        
        if $success; then
            print_success "健康检查通过"
        else
            print_warning "健康检查超时，服务可能仍在启动中"
        fi
    fi
}

# ==================== 显示完成信息 ====================
show_completion() {
    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                                                           ║${NC}"
    echo -e "${GREEN}║   ${BOLD}✅ 部署完成!${NC}${GREEN}                                          ║${NC}"
    echo -e "${GREEN}║                                                           ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${BOLD}📍 安装目录:${NC} $INSTALL_DIR"
    echo ""
    echo -e "${BOLD}🌐 访问地址:${NC}"
    echo "   应用首页:   http://localhost:${APP_PORT}"
    echo "   后台管理:   http://localhost:${APP_PORT}/login"
    echo ""
    echo -e "${BOLD}📝 常用命令:${NC}"
    echo "   cd $INSTALL_DIR"
    echo "   ./kerkerker.sh start    # 启动服务"
    echo "   ./kerkerker.sh stop     # 停止服务"
    echo "   ./kerkerker.sh logs     # 查看日志"
    echo "   ./kerkerker.sh update   # 更新版本"
    echo "   ./kerkerker.sh status   # 查看状态"
    echo "   ./kerkerker.sh backup   # 备份数据"
    echo ""
    echo -e "${BOLD}⚙️  修改配置:${NC}"
    echo -e "   配置文件位置: ${CYAN}$INSTALL_DIR/.env${NC}"
    echo ""
    echo "   可修改的配置项:"
    echo "   - ADMIN_PASSWORD    管理员密码"
    echo "   - TMDB_API_KEY      TMDB API 密钥 (获取影视信息)"
    echo "   - DOUBAN_API_PROXY  豆瓣代理地址 (获取豆瓣评分)"
    echo "   - APP_PORT          应用端口"
    echo ""
    echo -e "   修改后执行: ${CYAN}./kerkerker.sh restart${NC}"
    echo ""
    
    # 显示服务状态
    echo -e "${BOLD}📊 当前状态:${NC}"
    cd "$INSTALL_DIR"
    $COMPOSE_CMD ps
    echo ""
    
    # 显示教程链接
    echo -e "${BOLD}📖 更多教程:${NC}"
    echo "   项目文档: https://github.com/unilei/kerkerker"
    echo "   TMDB 注册: https://www.themoviedb.org/settings/api"
    echo ""
}

# ==================== 主程序 ====================
main() {
    print_banner
    check_dependencies
    interactive_config
    create_config_files
    deploy_services
    show_completion
}

# 运行主程序
main

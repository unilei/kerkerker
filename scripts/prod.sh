#!/bin/bash

# 生产环境部署脚本
# 用途：构建多平台镜像、推送到 Docker Hub、启动生产环境容器

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}   Kerkerker 生产环境部署脚本${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 检查 Docker 是否运行
if ! docker info > /dev/null 2>&1; then
  echo -e "${RED}❌ Docker 未运行，请先启动 Docker${NC}"
  exit 1
fi

# 检查 .env 文件
if [ ! -f .env ]; then
  echo -e "${RED}❌ 未找到 .env 文件，请先配置环境变量${NC}"
  exit 1
fi

# 询问是否推送到 Docker Hub
echo -e "${YELLOW}是否推送镜像到 Docker Hub? (y/N): ${NC}"
read -r PUSH_TO_HUB

if [[ $PUSH_TO_HUB =~ ^[Yy]$ ]]; then
  # 检查 Docker Hub 用户名
  if [ -z "$DOCKER_USERNAME" ]; then
    echo -e "${YELLOW}⚠️  未设置 DOCKER_USERNAME 环境变量${NC}"
    read -p "请输入 Docker Hub 用户名: " DOCKER_USERNAME
    export DOCKER_USERNAME
  fi

  # 询问版本号
  echo -e "${YELLOW}请输入版本号 (默认: latest): ${NC}"
  read -r VERSION
  VERSION=${VERSION:-latest}

  IMAGE_NAME="${DOCKER_USERNAME}/kerkerker"
  IMAGE_TAG="${IMAGE_NAME}:${VERSION}"
  IMAGE_LATEST="${IMAGE_NAME}:latest"

  echo ""
  echo -e "${BLUE}📦 镜像信息：${NC}"
  echo -e "  用户名: ${YELLOW}${DOCKER_USERNAME}${NC}"
  echo -e "  镜像名: ${YELLOW}${IMAGE_NAME}${NC}"
  echo -e "  版本号: ${YELLOW}${VERSION}${NC}"
  echo ""

  # 检查是否已登录 Docker Hub
  echo -e "${BLUE}🔐 检查 Docker Hub 登录状态...${NC}"
  if ! docker info | grep -q "Username: ${DOCKER_USERNAME}"; then
    echo -e "${YELLOW}⚠️  未登录 Docker Hub，请先登录${NC}"
    docker login
  fi

  # 创建并使用 buildx 构建器
  echo -e "${BLUE}🔧 设置多平台构建器...${NC}"
  if ! docker buildx inspect multiarch-builder > /dev/null 2>&1; then
    docker buildx create --name multiarch-builder --use
  else
    docker buildx use multiarch-builder
  fi

  # 构建并推送多平台镜像
  echo -e "${BLUE}🔨 构建多平台镜像（linux/amd64, linux/arm64）...${NC}"
  if [ "$VERSION" != "latest" ]; then
    docker buildx build \
      --platform linux/amd64,linux/arm64 \
      --tag ${IMAGE_TAG} \
      --tag ${IMAGE_LATEST} \
      --push \
      .
  else
    docker buildx build \
      --platform linux/amd64,linux/arm64 \
      --tag ${IMAGE_TAG} \
      --push \
      .
  fi

  echo ""
  echo -e "${GREEN}✅ 镜像推送成功！${NC}"
  echo ""
  echo -e "${BLUE}📝 镜像信息：${NC}"
  echo -e "  完整镜像: ${GREEN}docker pull ${IMAGE_TAG}${NC}"
  if [ "$VERSION" != "latest" ]; then
    echo -e "  最新版本: ${GREEN}docker pull ${IMAGE_LATEST}${NC}"
  fi
  echo ""
  echo -e "${BLUE}🌐 Docker Hub：${NC}"
  echo -e "  ${GREEN}https://hub.docker.com/r/${IMAGE_NAME}${NC}"
  echo ""
fi

# 停止旧容器
echo -e "${BLUE}🛑 停止旧容器...${NC}"
docker-compose down

# 构建本地生产镜像
echo -e "${BLUE}🔨 构建本地生产环境镜像...${NC}"
docker-compose build --no-cache

# 启动服务
echo -e "${BLUE}🚀 启动生产服务...${NC}"
docker-compose up -d

# 等待服务启动
echo -e "${BLUE}⏳ 等待服务启动...${NC}"
sleep 10

# 健康检查
echo -e "${BLUE}🏥 执行健康检查...${NC}"
# 从 docker-compose.yml 读取应用端口映射
APP_PORT=$(grep -A 2 "container_name: kerkerker-app" docker-compose.yml | grep "ports" -A 1 | grep -o '[0-9]*:3000' | cut -d':' -f1)
APP_PORT=${APP_PORT:-3000}  # 默认使用 3000

for i in {1..10}; do
  if curl -f --noproxy localhost http://localhost:${APP_PORT}/api/health > /dev/null 2>&1; then
    echo -e "${GREEN}✅ 健康检查通过！${NC}"
    break
  fi
  if [ $i -eq 10 ]; then
    echo -e "${RED}❌ 健康检查失败，请查看日志${NC}"
    docker-compose logs app
    exit 1
  fi
  echo -e "${YELLOW}⏳ 重试 $i/10...${NC}"
  sleep 3
done

# 显示服务状态
echo ""
echo -e "${BLUE}📊 服务状态：${NC}"
docker-compose ps

echo ""
echo -e "${GREEN}✅ 生产环境部署成功！${NC}"
echo ""
echo -e "${BLUE}📝 常用命令：${NC}"
echo -e "  查看日志:  ${YELLOW}docker-compose logs -f app${NC}"
echo -e "  停止服务:  ${YELLOW}docker-compose down${NC}"
echo -e "  重启服务:  ${YELLOW}docker-compose restart${NC}"
echo -e "  查看状态:  ${YELLOW}docker-compose ps${NC}"
echo ""
echo -e "${BLUE}🌐 访问地址：${NC}"
echo -e "  应用:     ${GREEN}http://localhost:${APP_PORT}${NC}"
echo -e "  健康检查:  ${GREEN}http://localhost:${APP_PORT}/api/health${NC}"
echo ""

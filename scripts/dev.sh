#!/bin/bash

# 开发环境一键启动脚本
# 用途：快速启动本地开发环境（Docker + 热重载）

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}   Kerkerker 开发环境启动脚本${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 检查 Docker 是否运行
if ! docker info > /dev/null 2>&1; then
  echo -e "${RED}❌ Docker 未运行，请先启动 Docker${NC}"
  exit 1
fi

# 检查 .env 文件
if [ ! -f .env ]; then
  echo -e "${YELLOW}⚠️  未找到 .env 文件，正在从 .env.example 复制...${NC}"
  if [ -f .env.example ]; then
    cp .env.example .env
    echo -e "${GREEN}✅ .env 文件创建成功${NC}"
  else
    echo -e "${RED}❌ .env.example 文件不存在${NC}"
    exit 1
  fi
fi

# 清理旧容器（可选）
read -p "$(echo -e ${YELLOW}"是否清理旧的开发容器？(y/N): "${NC})" -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo -e "${BLUE}🧹 清理旧容器...${NC}"
  docker-compose -f docker-compose.dev.yml down -v
  echo -e "${GREEN}✅ 清理完成${NC}"
fi

# 构建开发镜像
echo -e "${BLUE}🔨 构建开发环境镜像...${NC}"
docker-compose -f docker-compose.dev.yml build

# 启动服务
echo -e "${BLUE}🚀 启动开发服务...${NC}"
docker-compose -f docker-compose.dev.yml up -d

# 等待服务启动
echo -e "${BLUE}⏳ 等待服务启动...${NC}"
sleep 5

# 检查服务状态
echo ""
echo -e "${BLUE}📊 服务状态：${NC}"
docker-compose -f docker-compose.dev.yml ps

# 显示日志提示
echo ""
echo -e "${GREEN}✅ 开发环境启动成功！${NC}"
echo ""
echo -e "${BLUE}📝 常用命令：${NC}"
echo -e "  查看日志:  ${YELLOW}docker-compose -f docker-compose.dev.yml logs -f app-dev${NC}"
echo -e "  停止服务:  ${YELLOW}docker-compose -f docker-compose.dev.yml down${NC}"
echo -e "  重启服务:  ${YELLOW}docker-compose -f docker-compose.dev.yml restart${NC}"
echo -e "  进入容器:  ${YELLOW}docker exec -it kerkerker-app-dev sh${NC}"
echo ""
echo -e "${BLUE}🌐 访问地址：${NC}"
echo -e "  应用:     ${GREEN}http://localhost:3000${NC}"
echo -e "  健康检查:  ${GREEN}http://localhost:3000/api/health${NC}"
echo -e "  Redis:    ${GREEN}localhost:6379${NC}"
echo -e "  MongoDB:  ${GREEN}localhost:27017${NC}"
echo ""
echo -e "${YELLOW}💡 提示：代码修改会自动热重载${NC}"
echo ""

# 跟踪日志（可选）
read -p "$(echo -e ${YELLOW}"是否实时查看应用日志？(y/N): "${NC})" -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  docker-compose -f docker-compose.dev.yml logs -f app-dev
fi

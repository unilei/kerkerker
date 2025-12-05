#!/bin/bash

# 豆瓣API代理 - 多账号部署脚本
# 将 Cloudflare Worker 代理部署到多个账号

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ==================== 账号配置 ====================
# 默认配置为空
accounts=()

# 尝试从 .env 文件加载
if [ -f .env ]; then
    # 读取 DOUBAN_PROXY_ACCOUNTS 变量
    # 注意：这里简单粗暴地 grep，如果 .env 格式复杂可能需要更严谨的解析
    # 假设格式：DOUBAN_PROXY_ACCOUNTS="acc1,acc2,acc3"
    env_accounts=$(grep "^DOUBAN_PROXY_ACCOUNTS=" .env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    
    if [ -n "$env_accounts" ]; then
        # 将逗号分隔的字符串转换为数组
        IFS=',' read -ra accounts <<< "$env_accounts"
    fi
fi

# 如果环境变量中没有配置，可以在这里硬编码（不推荐）
# accounts=(
#     "name:account_id:api_token"
# )

# 获取账号配置
# 格式: "账号名:kv_id:kv_preview_id:acc_id:acc_token"
get_account_field() {
    local config="$1"
    local field="$2"
    case "$field" in
        "name") echo "$config" | cut -d':' -f1 ;;
        "acc_id") echo "$config" | cut -d':' -f4 ;;
        "acc_token") echo "$config" | cut -d':' -f5 ;;
    esac
}

# Worker 名称
WORKER_NAME="douban-proxy"

# Worker 代码源文件路径
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WORKER_SOURCE_FILE="$PROJECT_ROOT/docs/cloudflare-douban-proxy.js"

# 创建临时目录
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# 生成 Worker 代码
generate_worker_code() {
    if [ -f "$WORKER_SOURCE_FILE" ]; then
        # 从源文件读取（跳过顶部的 JSDoc 注释块，保留其余代码）
        awk '/^\/\*\*/,/\*\// {next} /^[[:space:]]*$/ && !code {next} {code=1; print}' "$WORKER_SOURCE_FILE" > "$TEMP_DIR/index.js"
        log_info "使用 Worker 代码: $WORKER_SOURCE_FILE"
    else
        log_error "Worker 源文件不存在: $WORKER_SOURCE_FILE"
        log_info "请确保 docs/cloudflare-douban-proxy.js 文件存在"
        exit 1
    fi
}

# 生成 wrangler.toml
generate_wrangler_config() {
    local account_name=$1
    cat > "$TEMP_DIR/wrangler.toml" << EOF
name = "${WORKER_NAME}"
main = "index.js"
compatibility_date = "2024-01-01"
EOF
}

# 部署到单个账号
deploy_to_account() {
    local config=$1
    local name=$(get_account_field "$config" "name")
    local acc_id=$(get_account_field "$config" "acc_id")
    local acc_token=$(get_account_field "$config" "acc_token")
    
    if [[ -z "$acc_id" || -z "$acc_token" ]]; then
        log_error "账号 ${name} 配置不完整"
        return 1
    fi
    
    log_info "部署到账号: ${name}"
    
    export CLOUDFLARE_ACCOUNT_ID="${acc_id}"
    export CLOUDFLARE_API_TOKEN="${acc_token}"
    
    generate_wrangler_config "$name"
    
    cd "$TEMP_DIR"
    local output=$(npx wrangler deploy 2>&1)
    local exit_code=$?
    cd - > /dev/null
    
    if [ $exit_code -eq 0 ]; then
        local worker_url=$(echo "$output" | grep -o 'https://[^[:space:]]*\.workers\.dev' | head -1)
        if [[ -n "$worker_url" ]]; then
            log_success "部署成功: $worker_url"
            echo "$worker_url"
        else
            log_success "部署成功: https://${WORKER_NAME}.${name}.workers.dev"
            echo "https://${WORKER_NAME}.${name}.workers.dev"
        fi
        return 0
    else
        log_error "部署失败: $output"
        return 1
    fi
}

# 显示帮助
show_help() {
    cat << EOF
豆瓣API代理 - 多账号部署脚本

用法: $0 [选项]

选项:
  -h, --help     显示帮助信息
  --dry-run      模拟运行

配置方法:
  在 .env 文件中设置 DOUBAN_PROXY_ACCOUNTS 环境变量:
  DOUBAN_PROXY_ACCOUNTS="account1:ID:TOKEN,account2:ID:TOKEN"

获取账号信息:
  1. 登录 https://dash.cloudflare.com/
  2. Account ID: 在任意页面URL中或Workers页面右侧
  3. API Token: My Profile -> API Tokens -> Create Token
     选择 "Edit Cloudflare Workers" 模板

EOF
}

# 主函数
main() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help) show_help; exit 0 ;;
            --dry-run)
                log_info "模拟运行模式"
                log_info "配置的账号数: ${#accounts[@]}"
                exit 0
                ;;
            *) log_error "未知选项: $1"; show_help; exit 1 ;;
        esac
    done
    
    if [ ${#accounts[@]} -eq 0 ]; then
        log_error "未配置任何账号"
        log_info "请编辑脚本，在 accounts 数组中添加账号信息"
        log_info "使用 --help 查看配置说明"
        exit 1
    fi
    
    if ! command -v npx &> /dev/null; then
        log_error "npx 未安装，请先安装 Node.js"
        exit 1
    fi
    
    log_info "开始多账号部署"
    log_info "账号数量: ${#accounts[@]}"
    
    # 生成 Worker 代码
    generate_worker_code
    
    local success_count=0
    local total_count=${#accounts[@]}
    local deployed_urls=()
    
    for config in "${accounts[@]}"; do
        local name=$(get_account_field "$config" "name")
        echo
        log_info "======================================"
        log_info "处理账号: ${name}"
        log_info "======================================"
        
        local url=$(deploy_to_account "$config")
        if [ $? -eq 0 ]; then
            ((success_count++))
            deployed_urls+=("$url")
        fi
        
        sleep 1
    done
    
    # 输出结果
    echo
    log_info "======================================"
    log_info "部署完成"
    log_info "======================================"
    log_success "成功: ${success_count}/${total_count}"
    
    if [ ${#deployed_urls[@]} -gt 0 ]; then
        echo
        log_info "部署的 Worker URLs:"
        for url in "${deployed_urls[@]}"; do
            log_success "  $url"
        done
        
        # 保存到项目配置
        echo
        log_info "在 .env 中配置其中一个 URL:"
        log_info "  DOUBAN_API_PROXY=${deployed_urls[0]}"
    fi
    
    [ $success_count -eq $total_count ] && exit 0 || exit 1
}

main "$@"

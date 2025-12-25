export function Footer() {
  return (
    <footer className="mt-20 border-t border-gray-800 bg-gradient-to-b from-black to-gray-950">
      <div className="mx-auto px-4 md:px-12 py-12">
        {/* 免责声明 */}
        <div className="mb-8">
          <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
            <svg className="w-5 h-5 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            免责声明
          </h3>
          <div className="space-y-3 text-sm text-gray-400 leading-relaxed">
            <p>
              本站为<span className="text-white font-medium">技术学习和交流平台</span>，仅提供影视信息检索和导航服务。所有视频资源均来自互联网公开资源，本站不存储任何影视文件。
            </p>
            <p>
              本站提供的所有链接和资源均来自第三方网站，其版权归原作者及原网站所有。如果您认为本站侵犯了您的版权或权益，请联系我们，我们会及时删除相关内容。
            </p>
            <p>
              本站尊重知识产权，支持正版影视。我们<span className="text-white font-medium">强烈建议用户通过正规渠道</span>（如爱奇艺、腾讯视频、优酷等）观看影视内容，以支持影视创作者。
            </p>
            <p className="text-xs text-gray-500 mt-4">
              使用本站服务即表示您同意遵守相关法律法规，并自行承担使用本站服务可能产生的风险和责任。
            </p>
          </div>
        </div>

        {/* 分隔线 */}
        <div className="border-t border-gray-800 my-8"></div>

        {/* 底部信息 */}
        <div className="flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-gray-500">
          <div className="flex items-center gap-2">
            <span>© 2025 壳儿</span>
            <span className="text-gray-700">|</span>
            <span>仅供学习交流使用</span>
          </div>
          
          <div className="flex items-center gap-6">
            <a 
              href="https://github.com/unilei/kerkerker" 
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-gray-300 transition-colors flex items-center gap-1"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
              </svg>
              GitHub
            </a>
            <button 
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              className="hover:text-gray-300 transition-colors flex items-center gap-1"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
              </svg>
              回到顶部
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}

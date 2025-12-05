import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 3600; // 缓存 1 小时

interface DailymotionVideo {
  id: string;
  title: string;
  thumbnail: string;
  duration: string;
  url: string;
  created_time?: string;
}

interface DailymotionChannel {
  name: string;
  handle: string;
  avatar: string;
  videos: DailymotionVideo[];
  hasMore?: boolean;
  total?: number;
  page?: number;
}

// GraphQL 响应类型
interface GraphQLVideoNode {
  id: string;
  xid: string;
  title: string;
  thumbnailx60: string;
  thumbnailx120: string;
  thumbnailx240: string;
  thumbnailx720: string;
  bestAvailableQuality: string;
  duration: number;
  createdAt: string;
}

interface GraphQLResponse {
  data: {
    channel: {
      id: string;
      xid: string;
      displayName?: string;
      avatarURL?: string;
      channel_videos_all_videos: {
        pageInfo: {
          hasNextPage: boolean;
          nextPage: number;
        };
        edges: Array<{
          node: GraphQLVideoNode;
        }>;
      };
    };
  };
}


export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const username = searchParams.get('username') || 'kchow125';
  const page = parseInt(searchParams.get('page') || '1', 10);

  try {
    // 先尝试使用 REST API（无需认证）
    try {
      const channelData = await fetchChannelDataFromRestAPI(username, page);
      return NextResponse.json(channelData);
    } catch (restError) {
      console.log('REST API failed, trying GraphQL:', restError);
      // 如果 REST API 失败，尝试 GraphQL
      const channelData = await fetchChannelDataFromGraphQL(username, page);
      
      if (!channelData.videos || channelData.videos.length === 0) {
        return NextResponse.json(
          { error: 'No videos found for this channel' },
          { status: 404 }
        );
      }

      return NextResponse.json(channelData);
    }
  } catch (error) {
    console.error('Error fetching Dailymotion data:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to fetch Dailymotion data';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}

interface RestAPIVideo {
  id: string;
  title: string;
  thumbnail_240_url: string;
  duration: number;
  created_time: number;
}

interface RestAPIVideosResponse {
  list: RestAPIVideo[];
  page: number;
  limit: number;
  has_more: boolean;
}

async function fetchChannelDataFromRestAPI(
  channelName: string,
  page: number = 1
): Promise<DailymotionChannel> {
  // 使用 Dailymotion REST API v1
  const limit = 30;
  
  // 获取用户信息
  const userResponse = await fetch(
    `https://api.dailymotion.com/user/${channelName}?fields=id,screenname,avatar_240_url`
  );
  
  if (!userResponse.ok) {
    throw new Error(`Failed to fetch user: ${userResponse.status}`);
  }
  
  const userData = await userResponse.json();
  
  // 获取视频列表
  const videosResponse = await fetch(
    `https://api.dailymotion.com/user/${channelName}/videos?fields=id,title,thumbnail_240_url,duration,created_time&limit=${limit}&page=${page}`
  );
  
  if (!videosResponse.ok) {
    throw new Error(`Failed to fetch videos: ${videosResponse.status}`);
  }
  
  const videosData: RestAPIVideosResponse = await videosResponse.json();
  
  const videos: DailymotionVideo[] = videosData.list.map((video: RestAPIVideo) => {
    const durationFormatted = formatDuration(video.duration);
    
    return {
      id: video.id,
      title: video.title,
      thumbnail: video.thumbnail_240_url,
      duration: durationFormatted,
      url: `https://www.dailymotion.com/video/${video.id}`,
      created_time: video.created_time.toString(),
    };
  });
  
  return {
    name: userData.screenname || channelName,
    handle: `@${channelName}`,
    avatar: userData.avatar_240_url || '',
    videos,
    hasMore: videosData.has_more,
    page: videosData.page,
    total: videosData.list.length, // REST API 不提供 total，只能返回当前页的数量
  };
}

async function getAccessToken(): Promise<string> {
  try {
    const response = await fetch('https://graphql.api.dailymotion.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OAuth token error:', response.status, errorText);
      throw new Error(`Failed to get access token: ${response.status}`);
    }

    const data = await response.json();
    if (!data.access_token) {
      throw new Error('No access token in response');
    }
    
    return data.access_token;
  } catch (error) {
    console.error('Failed to get OAuth token:', error);
    throw error;
  }
}

async function fetchChannelDataFromGraphQL(
  channelName: string,
  page: number = 1
): Promise<DailymotionChannel> {
  // 先获取访问令牌
  const accessToken = await getAccessToken();

  const query = `query CHANNEL_VIDEOS_QUERY($channel_name: String!, $sort: String, $page: Int!, $allowExplicit: Boolean) {
  channel(name: $channel_name) {
    id
    xid
    displayName
    avatarURL(size: "x240")
    channel_videos_all_videos: videos(
      sort: $sort
      page: $page
      first: 30
      allowExplicit: $allowExplicit
    ) {
      pageInfo {
        hasNextPage
        nextPage
        __typename
      }
      edges {
        node {
          id
          xid
          title
          thumbnailx60: thumbnailURL(size: "x60")
          thumbnailx120: thumbnailURL(size: "x120")
          thumbnailx240: thumbnailURL(size: "x240")
          thumbnailx720: thumbnailURL(size: "x720")
          bestAvailableQuality
          duration
          createdAt
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`;

  const variables = {
    channel_name: channelName,
    sort: 'recent',
    page: page,
    allowExplicit: false,
  };

  const response = await fetch('https://graphql.api.dailymotion.com/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'Origin': 'https://www.dailymotion.com',
    },
    body: JSON.stringify({
      operationName: 'CHANNEL_VIDEOS_QUERY',
      variables,
      query,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('GraphQL error response:', errorText);
    throw new Error(`GraphQL request failed: ${response.status}`);
  }

  const data: GraphQLResponse = await response.json();

  if (!data.data?.channel) {
    throw new Error('Channel not found');
  }

  const channel = data.data.channel;
  const videos: DailymotionVideo[] = channel.channel_videos_all_videos.edges.map(
    (edge) => {
      const node = edge.node;
      const durationFormatted = formatDuration(node.duration);
      
      return {
        id: node.xid,
        title: node.title,
        thumbnail: node.thumbnailx240 || node.thumbnailx720 || node.thumbnailx120,
        duration: durationFormatted,
        url: `https://www.dailymotion.com/video/${node.xid}`,
        created_time: node.createdAt,
      };
    }
  );

  const pageInfo = channel.channel_videos_all_videos.pageInfo;

  return {
    name: channel.displayName || channelName,
    handle: `@${channelName}`,
    avatar: channel.avatarURL || '',
    videos,
    hasMore: pageInfo.hasNextPage,
    page: page,
    total: videos.length, // GraphQL 不提供 total count
  };
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}


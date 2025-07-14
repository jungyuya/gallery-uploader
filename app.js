// app.js
require('dotenv').config();
const express = require('express');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const multer = require('multer');
const multerS3 = require('multer-s3');
const path = require('path');
const cors = require('cors');
const serverless = require('serverless-http'); 

const app = express();

// --- CORS 설정 ---
const allowedOrigins = [
  'https://d2bqghnw8yytk.cloudfront.net', // 프로님의 CloudFront 도메인
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5501', // 프런트엔드 개발 서버 포트
  'http://127.0.0.1:5501'  // 프런트엔드 개발 서버 포트
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
      callback(null, true);
    } else {
      console.warn(`CORS: Not allowed origin - ${origin}`);
      callback(new Error(`Not allowed by CORS: ${origin}`));
    }
  },
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  credentials: true,
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

app.use(express.json());

// --- AWS S3 설정 (v3 방식) ---
let s3Client;
// Lambda 환경인지 확인하여 S3Client 초기화 방식을 다르게 합니다.
if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
  // Lambda 환경에서는 IAM 역할의 자격 증명을 자동으로 사용합니다.
  // AWS_REGION은 Lambda가 자동으로 제공합니다.
  s3Client = new S3Client({
    region: process.env.AWS_REGION, 
  });
  console.log('S3Client initialized for Lambda environment.');
} else {
  // 로컬 환경에서는 .env 파일의 자격 증명을 사용합니다.
  s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  console.log('S3Client initialized for local environment.');
}


// --- 인증 미들웨어 ---
const ADMIN_TOKEN = '123456';
const checkAdmin = (req, res, next) => {
  const token = req.headers['authorization'];
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ message: '권한이 없습니다. 관리자 토큰을 확인하세요.' });
  }
  next();
};

// --- Multer-S3 설정 (v3 S3Client 사용) ---
const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: process.env.AWS_BUCKET_NAME,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: function (req, file, cb) {
      const extension = path.extname(file.originalname);
      const filename = `gallery/${Date.now()}-${path.basename(file.originalname, extension)}${extension}`;
      cb(null, filename);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// --- API 라우트 ---
app.post('/upload', checkAdmin, upload.array('images', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ message: '이미지 파일이 없습니다.' });
  }
  const uploadedUrls = req.files.map(file => file.location);
  res.status(200).json({
    message: `🎉 ${req.files.length}개의 이미지가 S3에 성공적으로 업로드되었습니다!`,
    urls: uploadedUrls
  });
});

app.get('/images', async (req, res) => {
  const params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Prefix: 'gallery/'
  };
  try {
    console.log('Attempting to list objects from S3 bucket:', process.env.AWS_BUCKET_NAME, 'with prefix:', params.Prefix); // ✨ 추가
    const data = await s3Client.send(new ListObjectsV2Command(params));
    
    console.log('S3 ListObjectsV2Command response data (truncated):', JSON.stringify(data, null, 2).substring(0, 500) + '...'); // ✨ 응답 데이터 로깅 (길이 제한)

    if (!data.Contents || data.Contents.length === 0) {
      console.log('No images found in S3 bucket.'); // ✨ 추가
      return res.json([]);
    }
    const imageUrls = data.Contents
      .filter(item => item.Size > 0)
      .sort((a, b) => b.LastModified - a.LastModified)
      .map(item => `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${item.Key}`);
    
    console.log('Successfully generated image URLs count:', imageUrls.length); // ✨ 추가
    res.json(imageUrls);
  } catch (err) {
    console.error('S3 이미지 목록 조회 오류 (catch 블록):', err); // ✨ 에러 로그 강화
    // S3 오류가 발생했을 때 500을 반환하도록 되어 있음
    res.status(500).json({ message: '이미지를 불러오는 중 오류가 발생했습니다.' });
  }
});

app.delete('/image/:key', checkAdmin, async (req, res) => {
  const imageKey = `gallery/${req.params.key}`;
  const params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: imageKey
  };
  try {
    await s3Client.send(new DeleteObjectCommand(params));
    res.status(200).json({ message: `🗑️ 이미지가 성공적으로 삭제되었습니다: ${imageKey}` });
  } catch (err) {
    console.error(`S3 이미지 삭제 오류 (${imageKey}):`, err);
    if (err.name === 'NoSuchKey') {
      return res.status(404).json({ message: '삭제하려는 이미지를 찾을 수 없습니다.' });
    }
    res.status(500).json({ message: '이미지 삭제 중 오류가 발생했습니다.' });
  }
});

app.delete('/images/batch', checkAdmin, async (req, res) => {
  const { keys } = req.body;

  if (!keys || !Array.isArray(keys) || keys.length === 0) {
    return res.status(400).json({ message: '삭제할 이미지 키 목록이 유효하지 않습니다.' });
  }

  const objectsToDelete = keys.map(key => ({ Key: `gallery/${key}` }));

  const params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Delete: {
      Objects: objectsToDelete,
      Quiet: false
    }
  };

  try {
    const data = await s3Client.send(new DeleteObjectsCommand(params));

    if (data.Errors && data.Errors.length > 0) {
      console.error('S3 다중 이미지 삭제 중 일부 실패:', data.Errors);
      return res.status(207).json({
        message: '일부 이미지를 삭제하는 데 실패했습니다.',
        deleted: data.Deleted || [],
        errors: data.Errors
      });
    }

    res.status(200).json({
      message: `🗑️ ${keys.length}개의 이미지가 성공적으로 삭제되었습니다!`,
      deleted: data.Deleted || []
    });
  } catch (err) {
    console.error('S3 다중 이미지 삭제 오류:', err);
    res.status(500).json({ message: '이미지 삭제 중 오류가 발생했습니다.' });
  }
});

// Lambda에서 Express 앱을 실행하기 위해 모듈을 export 합니다.
// serverless-http에 basePath 옵션을 추가하여 API Gateway의 스테이지 경로를 올바르게 처리합니다.
module.exports.handler = async (event, context) => {
    console.log('Received event:', JSON.stringify(event, null, 2)); 
    console.log('Request path from proxy parameters:', event.pathParameters ? event.pathParameters.proxy : 'N/A');
    console.log('Raw path from event:', event.rawPath); 

    const handler = serverless(app, {
        basePath: event.requestContext.stage // API Gateway의 스테이지 이름 (예: 'default')을 basePath로 설정
    });
    return handler(event, context);
};


// 로컬 테스트를 위한 조건부 app.listen
// Lambda에 배포할 때는 이 부분이 실행되지 않습니다.
if (process.env.NODE_ENV !== 'production' && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const PORT = 3000;
  app.listen(PORT, () => {
    console.log(`🚀 S3 연동 갤러리 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
    console.log('CORS가 활성화되어 localhost/127.0.0.1의 모든 포트 및 지정된 CloudFront 도메인에서의 요청을 허용합니다.');
  });
}

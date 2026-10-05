import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { loadConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const config = loadConfig(); // fail fast on invalid env

  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.setGlobalPrefix('api');
  app.use(cookieParser());

  // CORS for the Next.js frontend (cookies are HttpOnly credentials).
  app.enableCors({
    origin: 'http://localhost:3000',
    credentials: true,
  });

  // class-validator on every write endpoint (whitelist + reject unknown keys).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  app.enableShutdownHooks(); // graceful Prisma disconnect + queue worker stop

  await app.listen(config.PORT);
  new Logger('Bootstrap').log(`TCERP backend listening on http://localhost:${config.PORT}/api`);
}

void bootstrap();

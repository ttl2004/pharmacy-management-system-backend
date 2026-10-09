import { envSchema } from './env.validation';

// Dựng lại cấu trúc lồng nhau từ env đã được validate. envSchema là nguồn duy nhất
// quyết định giá trị mặc định, ở đây chỉ đổi tên và đổi kiểu cho tiện dùng.
export default () => {
  const env = envSchema.parse(process.env);

  return {
    port: env.PORT,

    // URL kết nối đọc thẳng từ biến DATABASE_URL (Prisma CLI và Prisma Client dùng
    // chung biến này), ở đây chỉ cấu hình phần logging của Prisma.
    database: {
      logging: env.DB_LOGGING === 'true',
    },

    mail: {
      gmail: {
        user: env.MAIL_GMAIL_USER,
        appPassword: env.MAIL_GMAIL_APP_PASSWORD,
      },
      fromDefault: env.MAIL_FROM_DEFAULT,
      templateDir: env.MAIL_TEMPLATE_DIR,
      rabbitmq: {
        url: env.MAIL_RABBITMQ_URL,
        exchange: env.MAIL_RABBITMQ_EXCHANGE,
        queue: env.MAIL_RABBITMQ_QUEUE,
      },
    },

    superAdmin: {
      email: env.SUPER_ADMIN_EMAIL,
      username: env.SUPER_ADMIN_USERNAME,
      password: env.SUPER_ADMIN_PASSWORD,
      fullName: env.SUPER_ADMIN_FULL_NAME,
      phoneNumber: env.SUPER_ADMIN_PHONE_NUMBER,
      address: env.SUPER_ADMIN_ADDRESS,
      dateOfBirth: env.SUPER_ADMIN_DATE_OF_BIRTH,
      gender: env.SUPER_ADMIN_GENDER,
    },
  };
};

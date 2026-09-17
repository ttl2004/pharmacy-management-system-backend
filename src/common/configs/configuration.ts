export default () => ({
  port: parseInt(process.env.PORT as string, 10),

  mongo: {
    uri: process.env.MONGO_URI,
  },

  mail: {
    gmail: {
      user: process.env.MAIL_GMAIL_USER,
      appPassword: process.env.MAIL_GMAIL_APP_PASSWORD,
    },
    fromDefault: process.env.MAIL_FROM_DEFAULT,
    templateDir: process.env.MAIL_TEMPLATE_DIR ?? 'src/providers/mailer/templates',
    rabbitmq: {
      url: process.env.MAIL_RABBITMQ_URL,
      exchange: process.env.MAIL_RABBITMQ_EXCHANGE ?? 'mailer.exchange',
      queue: process.env.MAIL_RABBITMQ_QUEUE ?? 'mailer.queue',
    },
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRESIN,
    signOptions: {
      expiresIn: process.env.JWT_EXPIRESIN,
    },
  },

  security: {
    cookieSecret: process.env.COOKIE_SECRET,
  },

  superAdmin: {
    email: process.env.SUPER_ADMIN_EMAIL,
    username: process.env.SUPER_ADMIN_USERNAME,
    password: process.env.SUPER_ADMIN_PASSWORD,
    fullName: process.env.SUPER_ADMIN_FULL_NAME ?? 'Super Admin',
    phoneNumber: process.env.SUPER_ADMIN_PHONE_NUMBER ?? '',
    address: process.env.SUPER_ADMIN_ADDRESS ?? '',
    age: process.env.SUPER_ADMIN_AGE ?? '',
    gender: process.env.SUPER_ADMIN_GENDER ?? 'male',
  },
});

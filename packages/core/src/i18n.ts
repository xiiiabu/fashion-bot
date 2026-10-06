/**
 * Shared message catalogue — spec USR-001 (RU / UZ Latin MUST, EN SHOULD),
 * NFR-008 and ADM-011 (locale completeness must be checkable).
 *
 * Only strings that more than one surface needs live here: order statuses, fit
 * and AI explanations, notification bodies and stable error codes. The Mini App
 * and the admin panel keep their own screen copy.
 */

export const LOCALES = ['ru', 'uz', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/** USR-001: RU and UZ are required; EN ships once content is ready. */
export const REQUIRED_LOCALES: readonly Locale[] = ['ru', 'uz'];
export const DEFAULT_LOCALE: Locale = 'ru';

export const LOCALE_LABELS: Record<Locale, string> = {
  ru: 'Русский',
  uz: "O‘zbekcha",
  en: 'English',
};

type Dict = Record<string, string>;

const ru: Dict = {
  'order.status.DRAFT': 'Черновик',
  'order.status.QUOTED': 'Расчёт готов',
  'order.status.AWAITING_PAYMENT': 'Ожидает оплаты',
  'order.status.PAID': 'Оплачен',
  'order.status.CONFIRMED': 'Подтверждён',
  'order.status.PICKING': 'Собирается',
  'order.status.READY_FOR_HANDOVER': 'Готов к передаче',
  'order.status.IN_TRANSIT': 'В пути',
  'order.status.DELIVERED': 'Доставлен',
  'order.status.PAYMENT_FAILED': 'Оплата не прошла',
  'order.status.CANCELLED': 'Отменён',
  'order.status.PARTIALLY_CANCELLED': 'Частично отменён',
  'order.status.RETURN_REQUESTED': 'Возврат запрошен',
  'order.status.RETURN_IN_TRANSIT': 'Возврат в пути',
  'order.status.RETURNED': 'Возвращён',
  'order.status.REFUND_PENDING': 'Возврат средств в обработке',
  'order.status.PARTIALLY_REFUNDED': 'Частично возвращён',
  'order.status.REFUNDED': 'Средства возвращены',
  'order.status.DISPUTED': 'Спорная ситуация',
  'order.status.COMPLETED': 'Завершён',
  // SubOrder statuses — what the seller's half of the order is doing (ORD-004).
  'suborder.status.PENDING_CONFIRMATION': 'Ожидает подтверждения продавца',
  'suborder.status.CONFIRMED': 'Подтверждён продавцом',
  'suborder.status.REJECTED': 'Отклонён продавцом',
  'suborder.status.PICKING': 'Собирается',
  'suborder.status.READY_FOR_HANDOVER': 'Готов к передаче',
  'suborder.status.HANDED_OVER': 'Передан в доставку',
  'suborder.status.IN_TRANSIT': 'В пути',
  'suborder.status.DELIVERED': 'Доставлен',
  'suborder.status.CANCELLED': 'Отменён',
  'suborder.status.PARTIALLY_CANCELLED': 'Частично отменён',
  'suborder.status.RETURN_IN_PROGRESS': 'Оформляется возврат',
  'suborder.status.RETURNED': 'Возвращён',
  'suborder.status.COMPLETED': 'Завершён',

  // Payment statuses. Kept separate from the order's own status (ORD-010): an
  // order can be delivered while its payment is still being refunded.
  'payment.status.CREATED': 'Платёж создан',
  'payment.status.PENDING': 'Ожидает оплаты',
  'payment.status.AUTHORIZED': 'Сумма заблокирована',
  'payment.status.CAPTURED': 'Оплачено',
  'payment.status.FAILED': 'Оплата не прошла',
  'payment.status.CANCELLED': 'Платёж отменён',
  'payment.status.EXPIRED': 'Срок оплаты истёк',
  'payment.status.REFUND_PENDING': 'Возврат в обработке',
  'payment.status.PARTIALLY_REFUNDED': 'Частично возвращено',
  'payment.status.REFUNDED': 'Возвращено',
  'payment.status.CHARGEBACK': 'Оспаривание платежа',
  'payment.status.RECONCILIATION_HOLD': 'На сверке',

  'return.status.REQUESTED': 'Запрошен',
  'return.status.APPROVED': 'Одобрен',
  'return.status.REJECTED': 'Отклонён',
  'return.status.HANDED_OVER': 'Передан курьеру',
  'return.status.RECEIVED': 'Получен продавцом',
  'return.status.INSPECTED': 'Проверен',
  'return.status.REFUND_PENDING': 'Возврат средств в обработке',
  'return.status.REFUNDED': 'Средства возвращены',
  'return.status.CANCELLED': 'Отменён',
  'return.status.DISPUTED': 'Спор',

  'fit.measurements_match': 'Размер подобран по вашим меркам и размерной сетке бренда.',
  'fit.preferred_fit': 'Учли выбранную посадку и размерную сетку бренда.',
  'fit.estimate': 'Оценка по росту и весу — уточните мерки, чтобы было точнее.',
  'fit.usual_size': 'Опирались на ваш обычный размер в этом бренде.',
  'fit.feedback_adjusted': 'Покупатели отмечают особенности посадки этой модели.',
  'fit.between_sizes': 'Вы между размерами: посмотрите оба варианта.',
  'fit.low_confidence': 'Данных мало, поэтому не показываем размер как уверенную рекомендацию.',
  'fit.chart_only': 'Показываем размерную сетку бренда. Добавьте мерки — подберём размер.',
  'fit.no_chart': 'Бренд не предоставил размерную сетку для этой модели.',
  'fit.no_sizes': 'Нет доступных размеров.',
  'fit.out_of_stock_fallback': 'Рекомендованный размер закончился — показываем ближайший доступный.',
  'fit.disclaimer': 'Это рекомендация, а не гарантия посадки.',

  'ai.explain.style': 'Собрали в стиле {styles}.',
  'ai.explain.palette': 'Палитра: {colors}.',

  // Colour and style names. They live here rather than only in the Mini App
  // because they are interpolated into the stylist's explanation, which the
  // bot also sends as a message (AI-006). The keys are the taxonomy codes
  // verbatim — they are lower case, and writing them upper case made every
  // lookup miss and print "color.brown" to the shopper. Purely presentational
  // labels (occasions, outfit slots, silhouettes) stay in the app that renders
  // them.
  'color.black': 'чёрный',
  'color.white': 'белый',
  'color.grey': 'серый',
  'color.beige': 'бежевый',
  'color.brown': 'коричневый',
  'color.navy': 'тёмно-синий',
  'color.blue': 'синий',
  'color.green': 'зелёный',
  'color.olive': 'оливковый',
  'color.red': 'красный',
  'color.burgundy': 'бордовый',
  'color.pink': 'розовый',
  'color.purple': 'фиолетовый',
  'color.yellow': 'жёлтый',
  'color.orange': 'оранжевый',
  'color.cream': 'кремовый',
  'color.camel': 'кэмел',
  'color.silver': 'серебряный',
  'color.gold': 'золотой',
  'color.multicolor': 'разноцветный',
  'color.print': 'с принтом',

  'style.old_money': 'old money',
  'style.quiet_luxury': 'тихая роскошь',
  'style.business_formal': 'деловой формальный',
  'style.business_casual': 'деловой свободный',
  'style.smart_casual': 'smart casual',
  'style.minimal': 'минимализм',
  'style.streetwear': 'стритвир',
  'style.sporty': 'спортивный',
  'style.athleisure': 'athleisure',
  'style.bohemian': 'бохо',
  'style.romantic': 'романтичный',
  'style.evening': 'вечерний',
  'style.resort': 'курортный',
  'style.y2k': 'y2k',
  'style.preppy': 'preppy',
  'style.workwear': 'workwear',
  'style.national_modern': 'национальный модерн',
  'style.avant_garde': 'авангард',

  'ai.explain.coherent_formality': 'Вещи держат один уровень формальности.',
  'ai.explain.within_budget': 'Уложились в ваш бюджет.',
  'ai.explain.over_budget': 'Бюджет превышен — замените позицию, чтобы вернуться в лимит.',
  'ai.explain.curated': 'Эти вещи стилисты уже ставили вместе.',
  'ai.explain.proportions': 'Пропорции сбалансированы по объёму.',
  'ai.explain.multibrand': 'Образ из {count} магазинов — одна корзина и один чек.',
  'ai.unavailable': 'AI‑стилист временно недоступен. Каталог и оформление заказа работают.',
  'ai.no_result': 'Не нашли подходящий образ по этому запросу. Попробуйте изменить бюджет или стиль.',
  'ai.slot_unfilled': 'Не нашли подходящую позицию: {slot}.',

  'notify.payment_received': 'Оплата получена. Заказ {orderNumber} передан продавцам.',
  'notify.order_confirmed': 'Продавец подтвердил заказ {orderNumber}.',
  'notify.order_shipped': 'Заказ {orderNumber} в пути.',
  'notify.order_delivered': 'Заказ {orderNumber} доставлен. Как село по размеру?',
  'notify.return_approved': 'Возврат по заказу {orderNumber} одобрен.',
  'notify.refund_done': 'Возврат средств по заказу {orderNumber} выполнен.',
  'notify.back_in_stock': '{title} снова в наличии.',
  'notify.price_drop': '{title} — цена снизилась.',

  'error.VALIDATION_FAILED': 'Проверьте введённые данные.',
  'error.UNAUTHENTICATED': 'Нужно войти заново.',
  'error.FORBIDDEN': 'Недостаточно прав.',
  'error.NOT_FOUND': 'Не найдено.',
  'error.CONFLICT': 'Состояние изменилось — обновите экран.',
  'error.OUT_OF_STOCK': 'Товар закончился.',
  'error.RESERVATION_EXPIRED': 'Бронь истекла. Пересоберите корзину.',
  'error.QUOTE_EXPIRED': 'Расчёт устарел. Обновите сумму.',
  'error.ILLEGAL_STATE_TRANSITION': 'Это действие недоступно в текущем статусе.',
  'error.PAYMENT_UNAVAILABLE': 'Оплата сейчас недоступна.',
  'error.RATE_LIMITED': 'Слишком много запросов. Попробуйте позже.',
  'error.INTERNAL': 'Что-то пошло не так. Мы уже знаем.',
  'error.AMOUNT_MISMATCH': 'Сумма не совпала — заказ на проверке.',
};

const uz: Dict = {
  'order.status.DRAFT': 'Qoralama',
  'order.status.QUOTED': 'Hisob tayyor',
  'order.status.AWAITING_PAYMENT': "To‘lov kutilmoqda",
  'order.status.PAID': "To‘landi",
  'order.status.CONFIRMED': 'Tasdiqlandi',
  'order.status.PICKING': 'Yig‘ilmoqda',
  'order.status.READY_FOR_HANDOVER': 'Topshirishga tayyor',
  'order.status.IN_TRANSIT': 'Yo‘lda',
  'order.status.DELIVERED': 'Yetkazildi',
  'order.status.PAYMENT_FAILED': "To‘lov amalga oshmadi",
  'order.status.CANCELLED': 'Bekor qilindi',
  'order.status.PARTIALLY_CANCELLED': 'Qisman bekor qilindi',
  'order.status.RETURN_REQUESTED': 'Qaytarish so‘raldi',
  'order.status.RETURN_IN_TRANSIT': 'Qaytarish yo‘lda',
  'order.status.RETURNED': 'Qaytarildi',
  'order.status.REFUND_PENDING': "Pul qaytarish jarayonida",
  'order.status.PARTIALLY_REFUNDED': 'Qisman qaytarildi',
  'order.status.REFUNDED': 'Pul qaytarildi',
  'order.status.DISPUTED': 'Nizoli holat',
  'order.status.COMPLETED': 'Yakunlandi',
  'suborder.status.PENDING_CONFIRMATION': 'Sotuvchi tasdigʻi kutilmoqda',
  'suborder.status.CONFIRMED': 'Sotuvchi tasdiqladi',
  'suborder.status.REJECTED': 'Sotuvchi rad etdi',
  'suborder.status.PICKING': 'Yigʻilmoqda',
  'suborder.status.READY_FOR_HANDOVER': 'Topshirishga tayyor',
  'suborder.status.HANDED_OVER': 'Yetkazishga topshirildi',
  'suborder.status.IN_TRANSIT': 'Yoʻlda',
  'suborder.status.DELIVERED': 'Yetkazildi',
  'suborder.status.CANCELLED': 'Bekor qilindi',
  'suborder.status.PARTIALLY_CANCELLED': 'Qisman bekor qilindi',
  'suborder.status.RETURN_IN_PROGRESS': 'Qaytarish rasmiylashtirilmoqda',
  'suborder.status.RETURNED': 'Qaytarildi',
  'suborder.status.COMPLETED': 'Yakunlandi',

  'payment.status.CREATED': 'Toʻlov yaratildi',
  'payment.status.PENDING': 'Toʻlov kutilmoqda',
  'payment.status.AUTHORIZED': 'Summa bloklandi',
  'payment.status.CAPTURED': 'Toʻlandi',
  'payment.status.FAILED': 'Toʻlov amalga oshmadi',
  'payment.status.CANCELLED': 'Toʻlov bekor qilindi',
  'payment.status.EXPIRED': 'Toʻlov muddati tugadi',
  'payment.status.REFUND_PENDING': 'Qaytarish jarayonida',
  'payment.status.PARTIALLY_REFUNDED': 'Qisman qaytarildi',
  'payment.status.REFUNDED': 'Qaytarildi',
  'payment.status.CHARGEBACK': 'Toʻlov nizosi',
  'payment.status.RECONCILIATION_HOLD': 'Solishtirishda',

  'return.status.REQUESTED': 'So‘raldi',
  'return.status.APPROVED': 'Tasdiqlandi',
  'return.status.REJECTED': 'Rad etildi',
  'return.status.HANDED_OVER': 'Kuryerga topshirildi',
  'return.status.RECEIVED': 'Sotuvchi qabul qildi',
  'return.status.INSPECTED': 'Tekshirildi',
  'return.status.REFUND_PENDING': 'Pul qaytarish jarayonida',
  'return.status.REFUNDED': 'Pul qaytarildi',
  'return.status.CANCELLED': 'Bekor qilindi',
  'return.status.DISPUTED': 'Nizo',

  'fit.measurements_match': "O‘lcham sizning parametrlaringiz va brend jadvali bo‘yicha tanlandi.",
  'fit.preferred_fit': "Tanlangan o‘tirish turini va brend jadvalini hisobga oldik.",
  'fit.estimate': "Bo‘y va vazn bo‘yicha taxmin — aniqroq bo‘lishi uchun o‘lchamlarni kiriting.",
  'fit.usual_size': "Bu brenddagi odatdagi o‘lchamingizga tayandik.",
  'fit.feedback_adjusted': "Xaridorlar bu modelning o‘tirishida xususiyat borligini qayd etgan.",
  'fit.between_sizes': "Siz ikki o‘lcham orasidasiz: ikkisini ham ko‘rib chiqing.",
  'fit.low_confidence': "Ma’lumot kam, shuning uchun o‘lchamni ishonchli tavsiya sifatida ko‘rsatmaymiz.",
  'fit.chart_only': "Brend o‘lcham jadvalini ko‘rsatamiz. O‘lchamlaringizni kiritsangiz, tanlab beramiz.",
  'fit.no_chart': "Brend bu model uchun o‘lcham jadvalini bermagan.",
  'fit.no_sizes': "Mavjud o‘lchamlar yo‘q.",
  'fit.out_of_stock_fallback': "Tavsiya etilgan o‘lcham tugagan — eng yaqin mavjudini ko‘rsatamiz.",
  'fit.disclaimer': "Bu tavsiya, o‘tirish kafolati emas.",

  'ai.explain.style': '{styles} uslubida yig‘dik.',
  'ai.explain.palette': 'Ranglar: {colors}.',

  // Colour and style names. They live here rather than only in the Mini App
  // because they are interpolated into the stylist's explanation, which the
  // bot also sends as a message (AI-006). The keys are the taxonomy codes
  // verbatim — they are lower case, and writing them upper case made every
  // lookup miss and print "color.brown" to the shopper. Purely presentational
  // labels (occasions, outfit slots, silhouettes) stay in the app that renders
  // them.
  'color.black': 'qora',
  'color.white': 'oq',
  'color.grey': 'kulrang',
  'color.beige': 'bej',
  'color.brown': 'qoʻngʻir',
  'color.navy': 'toʻq koʻk',
  'color.blue': 'koʻk',
  'color.green': 'yashil',
  'color.olive': 'zaytun',
  'color.red': 'qizil',
  'color.burgundy': 'bordo',
  'color.pink': 'pushti',
  'color.purple': 'binafsha',
  'color.yellow': 'sariq',
  'color.orange': 'toʻq sariq',
  'color.cream': 'krem',
  'color.camel': 'kamel',
  'color.silver': 'kumush',
  'color.gold': 'tilla',
  'color.multicolor': 'rang-barang',
  'color.print': 'naqshli',

  'style.old_money': 'old money',
  'style.quiet_luxury': 'sokin hashamat',
  'style.business_formal': 'rasmiy ishbilarmon',
  'style.business_casual': 'erkin ishbilarmon',
  'style.smart_casual': 'smart casual',
  'style.minimal': 'minimalizm',
  'style.streetwear': 'stritvir',
  'style.sporty': 'sport',
  'style.athleisure': 'athleisure',
  'style.bohemian': 'boho',
  'style.romantic': 'romantik',
  'style.evening': 'kechki',
  'style.resort': 'kurort',
  'style.y2k': 'y2k',
  'style.preppy': 'preppy',
  'style.workwear': 'workwear',
  'style.national_modern': 'milliy zamonaviy',
  'style.avant_garde': 'avangard',
  
  'ai.explain.coherent_formality': 'Buyumlar bir xil rasmiylik darajasida.',
  'ai.explain.within_budget': 'Byudjetingizga sig‘dik.',
  'ai.explain.over_budget': 'Byudjet oshdi — limitga qaytish uchun bir buyumni almashtiring.',
  'ai.explain.curated': 'Bu buyumlarni stilistlar allaqachon birga qo‘ygan.',
  'ai.explain.proportions': 'Proporsiyalar hajm bo‘yicha muvozanatli.',
  'ai.explain.multibrand': '{count} do‘kondan yig‘ilgan uslub — bitta savat va bitta to‘lov.',
  'ai.unavailable': 'AI stilist vaqtincha ishlamaydi. Katalog va buyurtma ishlaydi.',
  'ai.no_result': 'Bu so‘rov bo‘yicha mos uslub topilmadi. Byudjet yoki uslubni o‘zgartirib ko‘ring.',
  'ai.slot_unfilled': 'Mos buyum topilmadi: {slot}.',

  'notify.payment_received': "To‘lov qabul qilindi. {orderNumber} buyurtmasi sotuvchilarga yuborildi.",
  'notify.order_confirmed': 'Sotuvchi {orderNumber} buyurtmasini tasdiqladi.',
  'notify.order_shipped': '{orderNumber} buyurtmasi yo‘lda.',
  'notify.order_delivered': "{orderNumber} buyurtmasi yetkazildi. O‘lcham qanday bo‘ldi?",
  'notify.return_approved': '{orderNumber} buyurtmasi bo‘yicha qaytarish tasdiqlandi.',
  'notify.refund_done': '{orderNumber} buyurtmasi bo‘yicha pul qaytarildi.',
  'notify.back_in_stock': '{title} yana mavjud.',
  'notify.price_drop': '{title} — narx tushdi.',

  'error.VALIDATION_FAILED': 'Kiritilgan ma’lumotlarni tekshiring.',
  'error.UNAUTHENTICATED': 'Qaytadan kirish kerak.',
  'error.FORBIDDEN': 'Huquq yetarli emas.',
  'error.NOT_FOUND': 'Topilmadi.',
  'error.CONFLICT': 'Holat o‘zgardi — ekranni yangilang.',
  'error.OUT_OF_STOCK': 'Mahsulot tugadi.',
  'error.RESERVATION_EXPIRED': 'Band qilish muddati tugadi. Savatni qayta yig‘ing.',
  'error.QUOTE_EXPIRED': 'Hisob eskirdi. Summani yangilang.',
  'error.ILLEGAL_STATE_TRANSITION': 'Bu amal hozirgi holatda mumkin emas.',
  'error.PAYMENT_UNAVAILABLE': "To‘lov hozir mavjud emas.",
  'error.RATE_LIMITED': 'Juda ko‘p so‘rov. Keyinroq urinib ko‘ring.',
  'error.INTERNAL': 'Nimadir xato ketdi. Biz allaqachon bilamiz.',
  'error.AMOUNT_MISMATCH': 'Summa mos kelmadi — buyurtma tekshiruvda.',
};

const en: Dict = {
  'order.status.DRAFT': 'Draft',
  'order.status.QUOTED': 'Quoted',
  'order.status.AWAITING_PAYMENT': 'Awaiting payment',
  'order.status.PAID': 'Paid',
  'order.status.CONFIRMED': 'Confirmed',
  'order.status.PICKING': 'Being packed',
  'order.status.READY_FOR_HANDOVER': 'Ready for handover',
  'order.status.IN_TRANSIT': 'In transit',
  'order.status.DELIVERED': 'Delivered',
  'order.status.PAYMENT_FAILED': 'Payment failed',
  'order.status.CANCELLED': 'Cancelled',
  'order.status.PARTIALLY_CANCELLED': 'Partially cancelled',
  'order.status.RETURN_REQUESTED': 'Return requested',
  'order.status.RETURN_IN_TRANSIT': 'Return in transit',
  'order.status.RETURNED': 'Returned',
  'order.status.REFUND_PENDING': 'Refund in progress',
  'order.status.PARTIALLY_REFUNDED': 'Partially refunded',
  'order.status.REFUNDED': 'Refunded',
  'order.status.DISPUTED': 'Disputed',
  'order.status.COMPLETED': 'Completed',
  'suborder.status.PENDING_CONFIRMATION': 'Awaiting seller confirmation',
  'suborder.status.CONFIRMED': 'Confirmed by the seller',
  'suborder.status.REJECTED': 'Rejected by the seller',
  'suborder.status.PICKING': 'Being picked',
  'suborder.status.READY_FOR_HANDOVER': 'Ready for handover',
  'suborder.status.HANDED_OVER': 'Handed to the courier',
  'suborder.status.IN_TRANSIT': 'In transit',
  'suborder.status.DELIVERED': 'Delivered',
  'suborder.status.CANCELLED': 'Cancelled',
  'suborder.status.PARTIALLY_CANCELLED': 'Partially cancelled',
  'suborder.status.RETURN_IN_PROGRESS': 'Return in progress',
  'suborder.status.RETURNED': 'Returned',
  'suborder.status.COMPLETED': 'Completed',

  'payment.status.CREATED': 'Payment created',
  'payment.status.PENDING': 'Awaiting payment',
  'payment.status.AUTHORIZED': 'Amount held',
  'payment.status.CAPTURED': 'Paid',
  'payment.status.FAILED': 'Payment failed',
  'payment.status.CANCELLED': 'Payment cancelled',
  'payment.status.EXPIRED': 'Payment expired',
  'payment.status.REFUND_PENDING': 'Refund in progress',
  'payment.status.PARTIALLY_REFUNDED': 'Partially refunded',
  'payment.status.REFUNDED': 'Refunded',
  'payment.status.CHARGEBACK': 'Chargeback',
  'payment.status.RECONCILIATION_HOLD': 'Held for reconciliation',

  'return.status.REQUESTED': 'Requested',
  'return.status.APPROVED': 'Approved',
  'return.status.REJECTED': 'Rejected',
  'return.status.HANDED_OVER': 'Handed over',
  'return.status.RECEIVED': 'Received by seller',
  'return.status.INSPECTED': 'Inspected',
  'return.status.REFUND_PENDING': 'Refund in progress',
  'return.status.REFUNDED': 'Refunded',
  'return.status.CANCELLED': 'Cancelled',
  'return.status.DISPUTED': 'Disputed',

  'fit.measurements_match': "Picked from your measurements and the brand's size chart.",
  'fit.preferred_fit': 'Your preferred fit and the brand size chart were applied.',
  'fit.estimate': 'Estimated from height and weight — add measurements for a sharper answer.',
  'fit.usual_size': 'Based on your usual size in this brand.',
  'fit.feedback_adjusted': 'Shoppers report this model fits differently from the chart.',
  'fit.between_sizes': 'You sit between two sizes — have a look at both.',
  'fit.low_confidence': 'Too little data, so this is not shown as a confident size.',
  'fit.chart_only': "Showing the brand's size chart. Add measurements and we will pick a size.",
  'fit.no_chart': 'The brand did not provide a size chart for this model.',
  'fit.no_sizes': 'No sizes available.',
  'fit.out_of_stock_fallback': 'The recommended size sold out — showing the nearest available one.',
  'fit.disclaimer': 'This is a recommendation, not a guarantee of fit.',

  'ai.explain.style': 'Built in a {styles} register.',
  'ai.explain.palette': 'Palette: {colors}.',

  // Colour and style names. They live here rather than only in the Mini App
  // because they are interpolated into the stylist's explanation, which the
  // bot also sends as a message (AI-006). The keys are the taxonomy codes
  // verbatim — they are lower case, and writing them upper case made every
  // lookup miss and print "color.brown" to the shopper. Purely presentational
  // labels (occasions, outfit slots, silhouettes) stay in the app that renders
  // them.
  'color.black': 'black',
  'color.white': 'white',
  'color.grey': 'grey',
  'color.beige': 'beige',
  'color.brown': 'brown',
  'color.navy': 'navy',
  'color.blue': 'blue',
  'color.green': 'green',
  'color.olive': 'olive',
  'color.red': 'red',
  'color.burgundy': 'burgundy',
  'color.pink': 'pink',
  'color.purple': 'purple',
  'color.yellow': 'yellow',
  'color.orange': 'orange',
  'color.cream': 'cream',
  'color.camel': 'camel',
  'color.silver': 'silver',
  'color.gold': 'gold',
  'color.multicolor': 'multicolour',
  'color.print': 'printed',

  'style.old_money': 'old money',
  'style.quiet_luxury': 'quiet luxury',
  'style.business_formal': 'business formal',
  'style.business_casual': 'business casual',
  'style.smart_casual': 'smart casual',
  'style.minimal': 'minimal',
  'style.streetwear': 'streetwear',
  'style.sporty': 'sporty',
  'style.athleisure': 'athleisure',
  'style.bohemian': 'bohemian',
  'style.romantic': 'romantic',
  'style.evening': 'evening',
  'style.resort': 'resort',
  'style.y2k': 'y2k',
  'style.preppy': 'preppy',
  'style.workwear': 'workwear',
  'style.national_modern': 'modern national',
  'style.avant_garde': 'avant-garde',
  
  'ai.explain.coherent_formality': 'The pieces hold one level of formality.',
  'ai.explain.within_budget': 'It fits your budget.',
  'ai.explain.over_budget': 'Over budget — swap one piece to get back under the limit.',
  'ai.explain.curated': 'Our stylists have already put these together.',
  'ai.explain.proportions': 'Proportions are balanced by volume.',
  'ai.explain.multibrand': 'A look from {count} stores — one cart, one checkout.',
  'ai.unavailable': 'The AI stylist is temporarily unavailable. Catalogue and checkout still work.',
  'ai.no_result': 'No matching look for this brief. Try changing the budget or the style.',
  'ai.slot_unfilled': 'No suitable piece found for: {slot}.',

  'notify.payment_received': 'Payment received. Order {orderNumber} has gone to the sellers.',
  'notify.order_confirmed': 'The seller confirmed order {orderNumber}.',
  'notify.order_shipped': 'Order {orderNumber} is on its way.',
  'notify.order_delivered': 'Order {orderNumber} was delivered. How did the sizes work out?',
  'notify.return_approved': 'The return on order {orderNumber} is approved.',
  'notify.refund_done': 'The refund for order {orderNumber} is complete.',
  'notify.back_in_stock': '{title} is back in stock.',
  'notify.price_drop': '{title} — the price dropped.',

  'error.VALIDATION_FAILED': 'Check the values you entered.',
  'error.UNAUTHENTICATED': 'Please sign in again.',
  'error.FORBIDDEN': 'Not enough permissions.',
  'error.NOT_FOUND': 'Not found.',
  'error.CONFLICT': 'The state changed — refresh the screen.',
  'error.OUT_OF_STOCK': 'This item is out of stock.',
  'error.RESERVATION_EXPIRED': 'The hold expired. Rebuild your cart.',
  'error.QUOTE_EXPIRED': 'The quote is stale. Refresh the total.',
  'error.ILLEGAL_STATE_TRANSITION': 'That action is not available in the current status.',
  'error.PAYMENT_UNAVAILABLE': 'Payment is unavailable right now.',
  'error.RATE_LIMITED': 'Too many requests. Try again shortly.',
  'error.INTERNAL': 'Something went wrong. We already know.',
  'error.AMOUNT_MISMATCH': 'Amounts did not match — the order is under review.',
};

export const MESSAGES: Record<Locale, Dict> = { ru, uz, en };

export function translate(
  locale: Locale,
  key: string,
  params: Record<string, string | number> = {},
): string {
  const dict = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];
  const template = dict[key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
}

export function makeTranslator(locale: Locale) {
  return (key: string, params?: Record<string, string | number>) => translate(locale, key, params);
}

/** ADM-011: report which required locales are missing a value. */
export function localeCompleteness(
  values: Partial<Record<Locale, string | null | undefined>>,
): { complete: boolean; missing: Locale[]; coverage: number } {
  const missing = REQUIRED_LOCALES.filter((locale) => {
    const value = values[locale];
    return value == null || value.trim() === '';
  });
  const filled = LOCALES.filter((locale) => {
    const value = values[locale];
    return value != null && value.trim() !== '';
  }).length;
  return { complete: missing.length === 0, missing, coverage: filled / LOCALES.length };
}

export function pickLocalized(
  values: Partial<Record<Locale, string | null | undefined>> | null | undefined,
  locale: Locale,
): string {
  if (!values) return '';
  return (
    values[locale] ??
    values[DEFAULT_LOCALE] ??
    LOCALES.map((candidate) => values[candidate]).find((value) => value) ??
    ''
  );
}

/** Normalise whatever Telegram reports into a locale we actually ship. */
export function resolveLocale(input: string | null | undefined): Locale {
  if (!input) return DEFAULT_LOCALE;
  const code = input.toLowerCase().slice(0, 2);
  if (code === 'uz') return 'uz';
  if (code === 'en') return 'en';
  if (code === 'ru') return 'ru';
  // Russian is the lingua franca of the Tashkent market; default there rather
  // than showing English to someone whose client is set to, say, kk or ky.
  return DEFAULT_LOCALE;
}

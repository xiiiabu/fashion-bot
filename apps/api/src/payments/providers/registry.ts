/**
 * Provider registry — PAY-001: "Provider можно добавить/выключить без
 * изменения order domain."
 *
 * Adding a PSP means adding a file and one line here. Nothing in orders,
 * ledger or checkout changes.
 */

import type { Provider } from '@nestjs/common';
import { loadConfig } from '../../common/config';
import { logger } from '../../common/logger';
import type { PaymentProvider } from './provider.interface';
import { MockPaymentProvider } from './mock.provider';
import { PaymePaymentProvider } from './payme.provider';
import { ClickPaymentProvider } from './click.provider';
import { UzumPaymentProvider } from './uzum.provider';

export const PAYMENT_PROVIDERS = 'PAYMENT_PROVIDERS';

export const paymentProvidersProvider: Provider = {
  provide: PAYMENT_PROVIDERS,
  useFactory: (): PaymentProvider[] => {
    const config = loadConfig();
    const providers: PaymentProvider[] = [];

    // The sandbox provider only exists while payments are not live, which is
    // the state this release ships in (§8.4 decision gate).
    if (!config.PAYMENTS_LIVE) {
      providers.push(new MockPaymentProvider());
    }

    providers.push(new PaymePaymentProvider(), new ClickPaymentProvider(), new UzumPaymentProvider());

    const enabled = providers.filter((provider) => provider.enabled);
    const selected = enabled.filter((provider) => config.PAYMENT_PROVIDERS.includes(provider.code));

    logger.info(
      {
        registered: providers.map((provider) => provider.code),
        enabled: enabled.map((provider) => provider.code),
        selected: selected.map((provider) => provider.code),
        live: config.PAYMENTS_LIVE,
      },
      'payment providers initialised',
    );

    if (selected.length === 0 && config.PAYMENTS_ENABLED) {
      logger.warn(
        { configured: config.PAYMENT_PROVIDERS },
        'no usable payment provider — checkout will report PAYMENT_UNAVAILABLE',
      );
    }

    return providers;
  },
};
